// Vercel serverless function: /api/affirm-capture
//
// Direct Affirm integration (merchant's own Affirm account). The browser
// runs affirm.checkout.open(); on success Affirm hands back a checkout_token,
// which this endpoint exchanges for a charge (authorize) and immediately
// captures. On success the shared fulfillment module adjusts inventory and
// logs the order. Affirm's merchant fee isn't returned by their API, so the
// order log notes "per Affirm statement" instead of an exact fee.
//
// Required environment variables (Vercel Project Settings):
//   AFFIRM_PUBLIC_KEY
//   AFFIRM_PRIVATE_KEY
//   SUPABASE_SERVICE_ROLE_KEY (for inventory auto-adjustment)
// Optional:
//   AFFIRM_ENV = "sandbox" for test mode (defaults to live)

const { fulfillAndLogOrder } = require("./_fulfill");

const AFFIRM_BASE =
  process.env.AFFIRM_ENV === "sandbox" ? "https://sandbox.affirm.com" : "https://api.affirm.com";

function affirmAuth() {
  const pub = process.env.AFFIRM_PUBLIC_KEY;
  const priv = process.env.AFFIRM_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("Affirm is not configured on the server.");
  return `Basic ${Buffer.from(`${pub}:${priv}`).toString("base64")}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { checkout_token, meta } = body;
  if (!checkout_token) {
    res.status(400).json({ error: "Missing checkout_token." });
    return;
  }

  try {
    const auth = affirmAuth();

    // 1) Authorize: exchange the checkout token for a charge.
    const authResp = await fetch(`${AFFIRM_BASE}/api/v2/charges`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ checkout_token }),
    });
    const charge = await authResp.json();
    if (!authResp.ok || !charge.id) {
      console.error("Affirm authorize failed", charge);
      res.status(402).json({ error: "Affirm couldn't authorize this payment.", details: charge });
      return;
    }

    // 2) Capture the charge.
    const capResp = await fetch(`${AFFIRM_BASE}/api/v2/charges/${encodeURIComponent(charge.id)}/capture`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const capture = await capResp.json();
    if (!capResp.ok) {
      console.error("Affirm capture failed", capture);
      res.status(402).json({ error: "Affirm authorized but capture failed - contact Affirm support.", details: capture });
      return;
    }

    const grossCents = Number(capture.amount != null ? capture.amount : charge.amount) || 0;

    await fulfillAndLogOrder(
      {
        id: `affirm_${charge.id}`,
        method: "affirm",
        gross: grossCents / 100,
        fee: null,
        net: null,
        feeNote: "fee per Affirm statement",
      },
      meta || {},
    );

    res.status(200).json({ ok: true, chargeId: charge.id });
  } catch (err) {
    console.error("Affirm capture error", err);
    res.status(502).json({ error: err.message || "Could not reach Affirm." });
  }
};
