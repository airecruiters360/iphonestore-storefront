// Vercel serverless function: /api/paypal-config
//
// Returns the PUBLIC keys the storefront needs to render checkout: the
// PayPal client id and (if configured) the Affirm public key. Both are
// public by design - they ship to every browser. Secrets never leave the
// server-side /api/*-capture endpoints.
//
// Environment variables (Vercel Project Settings):
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET  - PayPal (required for checkout)
//   AFFIRM_PUBLIC_KEY / AFFIRM_PRIVATE_KEY   - Affirm financing (optional)
//   PAYPAL_ENV / AFFIRM_ENV = "sandbox"      - test modes (default live)

module.exports = async function handler(req, res) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  res.status(200).json({
    configured: !!clientId,
    clientId: clientId || null,
    env: process.env.PAYPAL_ENV === "sandbox" ? "sandbox" : "live",
    affirmPublicKey: process.env.AFFIRM_PUBLIC_KEY || null,
    affirmEnv: process.env.AFFIRM_ENV === "sandbox" ? "sandbox" : "live",
  });
};
