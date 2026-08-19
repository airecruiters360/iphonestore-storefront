// Vercel serverless function: /api/afs-charge
//
// Dedicated credit/debit card processor (Agile Financial Systems / AFS,
// an NMI-gateway reseller) - kept separate from PayPal so a customer's
// card is never run through PayPal's own guest card acceptance. That path
// was the root cause of a real incompatibility: some customers are issued
// a card by Affirm itself (a bank-issued Mastercard drawing on an Affirm
// credit line), and PayPal's guest card checkout was inconsistently
// rejecting that card type. AFS/NMI is a normal card gateway with no such
// restriction.
//
// The browser tokenizes the card with AFS's Collect.js (using the public
// Tokenization Key baked into index.html - not a secret) and posts the
// resulting one-time token here. This endpoint exchanges it for a real
// charge via AFS's transact.php, then hands off to the shared fulfillment
// module (api/_fulfill.js) which pulls the sold devices out of inventory
// (recording IMEIs) and logs the order - the same path every other
// processor in this repo uses.
//
// Required environment variable (Vercel Project Settings):
//   AFS_PRIVATE_KEY  - the "Private Key" / security key from the AFS
//                      merchant portal (payments.go-afs.com), paired with
//                      the Key ID shown there. Never used client-side.

const { fulfillAndLogOrder } = require("./_fulfill");

const AFS_TRANSACT_URL = "https://payments.go-afs.com/api/transact.php";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const privateKey = process.env.AFS_PRIVATE_KEY;
  if (!privateKey) {
    res.status(500).json({
      error:
        "Server is missing AFS_PRIVATE_KEY. Add it in Vercel Project Settings -> Environment Variables.",
    });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { paymentToken, amount, meta } = body;

  if (!paymentToken) {
    res.status(400).json({ error: "Missing paymentToken." });
    return;
  }
  if (!amount || Number(amount) <= 0) {
    res.status(400).json({ error: "Missing or invalid amount." });
    return;
  }

  const m = meta || {};
  const params = new URLSearchParams();
  params.append("security_key", privateKey);
  params.append("type", "sale");
  params.append("payment_token", paymentToken);
  params.append("amount", Number(amount).toFixed(2));
  params.append("orderid", "web-" + Date.now());

  if (m.customer_name) {
    const parts = String(m.customer_name).trim().split(/\s+/);
    params.append("first_name", parts[0] || "");
    params.append("last_name", parts.slice(1).join(" ") || "");
  }
  if (m.customer_email) params.append("email", m.customer_email);
  if (m.customer_phone) params.append("phone", m.customer_phone);
  if (m.shipping_address1) params.append("address1", m.shipping_address1);
  if (m.shipping_address2) params.append("address2", m.shipping_address2);
  if (m.shipping_city) params.append("city", m.shipping_city);
  if (m.shipping_state) params.append("state", m.shipping_state);
  if (m.shipping_zip) params.append("zip", m.shipping_zip);

  try {
    const resp = await fetch(AFS_TRANSACT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const text = await resp.text();
    const result = Object.fromEntries(new URLSearchParams(text));

    // NMI-style response codes: response "1" = approved, "2" = declined,
    // "3" = error. Anything other than "1" means no charge went through.
    if (result.response !== "1") {
      console.error("AFS charge declined/error", result);
      res.status(402).json({
        error: result.responsetext || "Card could not be charged.",
        details: result,
      });
      return;
    }

    await fulfillAndLogOrder(
      {
        id: "afs_" + result.transactionid,
        method: "afs_card",
        gross: Number(amount),
        fee: null,
        net: null,
        feeNote: "fee per AFS statement",
      },
      m,
    );

    res.status(200).json({ ok: true, transactionId: result.transactionid, authCode: result.authcode });
  } catch (err) {
    console.error("AFS charge error", err);
    res.status(502).json({ error: err.message || "Could not reach AFS." });
  }
};
