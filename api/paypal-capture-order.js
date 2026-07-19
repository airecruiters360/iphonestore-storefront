// Vercel serverless function: /api/paypal-capture-order
//
// Captures an approved PayPal Order server-side, then hands the completed
// order to the shared fulfillment module (api/_fulfill.js) which pulls sold
// devices out of inventory (recording their IMEIs) and logs one order row per
// item - including PayPal's exact fee and net payout from the capture's
// seller_receivable_breakdown.
//
// Required environment variables (Vercel Project Settings):
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
//   SUPABASE_SERVICE_ROLE_KEY  (for inventory auto-adjustment; orders still
//                               complete + log without it)
// Optional:
//   PAYPAL_ENV = "sandbox" for test mode (defaults to live)

const { fulfillAndLogOrder } = require("./_fulfill");

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

async function paypalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal is not configured on the server.");
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await resp.json();
  if (!resp.ok || !json.access_token) throw new Error("Could not authenticate with PayPal.");
  return json.access_token;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { orderID, meta } = body;
  if (!orderID) {
    res.status(400).json({ error: "Missing orderID." });
    return;
  }
  const m = meta || {};

  try {
    const token = await paypalAccessToken();
    const capResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const capJson = await capResp.json();

    const capture =
      capJson &&
      capJson.purchase_units &&
      capJson.purchase_units[0] &&
      capJson.purchase_units[0].payments &&
      capJson.purchase_units[0].payments.captures &&
      capJson.purchase_units[0].payments.captures[0];

    if (!capResp.ok || !capture || capture.status !== "COMPLETED") {
      console.error("PayPal capture failed", JSON.stringify(capJson));
      res.status(capResp.ok ? 402 : capResp.status).json({
        error: "Payment could not be completed.",
        details: capJson && capJson.details,
      });
      return;
    }

    // PayPal's own numbers - the same gross/fee/net the dashboard shows.
    const brk = capture.seller_receivable_breakdown || {};
    const gross = Number((brk.gross_amount && brk.gross_amount.value) || (capture.amount && capture.amount.value) || 0);
    const fee = brk.paypal_fee && brk.paypal_fee.value != null ? Number(brk.paypal_fee.value) : null;
    const net = brk.net_amount && brk.net_amount.value != null ? Number(brk.net_amount.value) : null;

    await fulfillAndLogOrder(
      {
        id: `paypal_${capture.id}`,
        method: m.funding_source ? `paypal_${m.funding_source}` : "paypal",
        gross,
        fee,
        net,
      },
      m,
    );

    res.status(200).json({ ok: true, captureId: capture.id, status: capture.status });
  } catch (err) {
    console.error("PayPal capture error", err);
    res.status(502).json({ error: err.message || "Could not reach PayPal." });
  }
};
