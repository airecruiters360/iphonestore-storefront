// Vercel serverless function: /api/paypal-config
//
// Returns the PUBLIC PayPal client id so the storefront can load the
// PayPal JS SDK without hardcoding the id into the HTML. The client id
// is public by design (it ships to every browser); the secret never
// leaves the server.
//
// Required environment variables (Vercel Project Settings):
//   PAYPAL_CLIENT_ID     - from developer.paypal.com -> Apps & Credentials (Live)
//   PAYPAL_CLIENT_SECRET - same page (used by the other /api/paypal-* functions)
// Optional:
//   PAYPAL_ENV           - "sandbox" for test mode; defaults to live.

module.exports = async function handler(req, res) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) {
    res.status(200).json({ configured: false });
    return;
  }
  res.status(200).json({ configured: true, clientId, env: process.env.PAYPAL_ENV === "sandbox" ? "sandbox" : "live" });
};
