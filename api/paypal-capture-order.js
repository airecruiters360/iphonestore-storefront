// Vercel serverless function: /api/paypal-capture-order
//
// Captures an approved PayPal Order server-side and, on success, writes the
// completed order into Supabase (storefront_inquiries) - the same record the
// old Stripe webhook used to write. Capture is synchronous, so unlike the
// Stripe flow no webhook is needed: if this returns COMPLETED, the money is
// captured and the order is logged in one round trip.
//
// Required environment variables (Vercel Project Settings):
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
// Optional:
//   PAYPAL_ENV = "sandbox" for test mode (defaults to live)

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

const SUPABASE_URL = "https://xggkxvecfrdtiakkwdgp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhnZ2t4dmVjZnJkdGlha2t3ZGdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTMxMjAsImV4cCI6MjA5ODY2OTEyMH0.s9ERsiEJJTTeXUJHQ6CL9hHSbtJ5FpqgXLu_Hjku-_g";

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

    const amountCharged = Number(capture.amount && capture.amount.value) || null;

    // Same folding trick the Stripe webhook used: shipping + warranty ride in
    // the free-text message field so no database schema change is needed.
    const shippingLine = [m.shipping_address1, m.shipping_address2, m.shipping_city, m.shipping_state, m.shipping_zip]
      .filter(Boolean)
      .join(", ");
    const extraNotes = [
      shippingLine ? `Ship to: ${shippingLine}` : null,
      m.warranty_label ? `Warranty: ${m.warranty_label}` : null,
      m.pay_mode ? `Pay mode: ${m.pay_mode}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    const combinedMessage = [m.message, extraNotes].filter(Boolean).join(" || ") || null;

    try {
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/storefront_inquiries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          listing_id: m.listing_id || null,
          device_catalog_id: m.device_catalog_id || null,
          product_name: m.product_name || null,
          color: m.color || null,
          storage: m.storage || null,
          condition_grade: m.condition_grade || null,
          retail_price: amountCharged,
          customer_name: m.customer_name || "PayPal checkout",
          customer_phone: m.customer_phone || null,
          customer_email: m.customer_email || null,
          message: combinedMessage,
          accessory_bundle: m.accessory_bundle || null,
          accessory_bundle_price: m.accessory_bundle_price != null && m.accessory_bundle_price !== ""
            ? Number(m.accessory_bundle_price)
            : null,
          payment_method: m.funding_source ? `paypal_${m.funding_source}` : "paypal",
          payment_status: "succeeded",
          amount_charged: amountCharged,
          // Existing column reused so no schema change is needed - prefixed so
          // PayPal capture ids are never mistaken for Stripe intent ids.
          stripe_payment_intent_id: `paypal_${capture.id}`,
        }),
      });
      if (!insertResp.ok) {
        console.error("Supabase insert failed", await insertResp.text());
      }
    } catch (err) {
      console.error("Supabase insert error", err);
    }

    res.status(200).json({ ok: true, captureId: capture.id, status: capture.status });
  } catch (err) {
    console.error("PayPal capture error", err);
    res.status(502).json({ error: err.message || "Could not reach PayPal." });
  }
};
