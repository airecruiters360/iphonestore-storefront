// Vercel serverless function: /api/stripe-webhook
//
// Klarna, Afterpay, and Cash App Pay all confirm asynchronously (the
// customer is redirected away to authorize, then comes back), so the
// reliable way to know a payment actually completed is Stripe's webhook
// - not the browser redirect. This endpoint verifies the webhook
// signature and, on payment_intent.succeeded, writes the completed
// order into Supabase next to the existing reservation data.
//
// Required environment variables (set in Vercel Project Settings):
//   STRIPE_WEBHOOK_SECRET  - starts with whsec_..., shown when you add
//                            this URL as an endpoint in the Stripe
//                            Dashboard (Developers -> Webhooks)
//
// After deploying, add this endpoint in Stripe:
//   https://iphonestore.io/api/stripe-webhook
// and subscribe it to the payment_intent.succeeded event.

const crypto = require("crypto");

const SUPABASE_URL = "https://xggkxvecfrdtiakkwdgp.supabase.co";
const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhnZ2t4dmVjZnJkdGlha2t3ZGdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTMxMjAsImV4cCI6MjA5ODY2OTEyMH0.s9ERsiEJJTTeXUJHQ6CL9hHSbtJ5FpqgXLu_Hjku-_g";

module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
    return new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
    });
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;
    const parts = Object.fromEntries(
          signatureHeader.split(",").map((part) => part.split("="))
        );
    const timestamp = parts.t;
    const expectedSig = parts.v1;
    if (!timestamp || !expectedSig) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
    const computedSig = crypto
      .createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest("hex");

  const a = Buffer.from(computedSig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
          res.status(405).json({ error: "Method not allowed" });
          return;
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
          console.error("Missing STRIPE_WEBHOOK_SECRET env var.");
          res.status(500).json({ error: "Webhook not configured." });
          return;
    }

    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString("utf8");
    const signatureHeader = req.headers["stripe-signature"];

    if (!verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
          console.error("Stripe webhook signature verification failed.");
          res.status(400).json({ error: "Invalid signature." });
          return;
    }

    let event;
    try {
          event = JSON.parse(rawBody);
    } catch (err) {
          res.status(400).json({ error: "Invalid payload." });
          return;
    }

    if (event.type === "payment_intent.succeeded") {
          const intent = event.data.object;
          const metadata = intent.metadata || {};

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
                                    listing_id: metadata.listing_id || null,
                                    device_catalog_id: metadata.device_catalog_id || null,
                                    product_name: metadata.product_name || null,
                                    color: metadata.color || null,
                                    storage: metadata.storage || null,
                                    condition_grade: metadata.condition_grade || null,
                                    retail_price: intent.amount / 100,
                                    customer_name: metadata.customer_name || "Stripe checkout",
                                    customer_phone: metadata.customer_phone || null,
                                    customer_email: metadata.customer_email || null,
                                    message: metadata.message || null,
                                    accessory_bundle: metadata.accessory_bundle || null,
                                    accessory_bundle_price: metadata.accessory_bundle_price
                                      ? Number(metadata.accessory_bundle_price)
                                                  : null,
                                    payment_method: intent.payment_method_types && intent.payment_method_types[0],
                                    payment_status: intent.status,
                                    amount_charged: intent.amount / 100,
                                    stripe_payment_intent_id: intent.id,
                        }),
              });
              if (!insertResp.ok) {
                        console.error("Supabase insert failed", await insertResp.text());
              }
      } catch (err) {
              console.error("Supabase insert error", err);
      }
    }

    res.status(200).json({ received: true });
};
