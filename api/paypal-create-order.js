// Vercel serverless function: /api/paypal-create-order
//
// Creates a PayPal Order (Orders v2 API) for the storefront checkout and
// returns its id. The browser's PayPal Buttons call this from createOrder().
// Replaces the old Stripe /api/create-payment-intent endpoint.
//
// Required environment variables (Vercel Project Settings):
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
// Optional:
//   PAYPAL_ENV = "sandbox" for test mode (defaults to live)
//
// Uses PayPal's REST API directly via fetch - no SDK dependency, so this
// repo still needs no build step.

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

async function paypalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "Server is missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Add them in Vercel Project Settings -> Environment Variables.",
    );
  }
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await resp.json();
  if (!resp.ok || !json.access_token) {
    console.error("PayPal OAuth failed", json);
    throw new Error("Could not authenticate with PayPal.");
  }
  return json.access_token;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { amount, productName, listingId } = body;

  if (!amount || Number(amount) <= 0) {
    res.status(400).json({ error: "Missing or invalid amount." });
    return;
  }

  try {
    const token = await paypalAccessToken();
    const orderResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: listingId || undefined,
            description: (productName || "Device purchase").slice(0, 127),
            amount: { currency_code: "USD", value: Number(amount).toFixed(2) },
          },
        ],
      }),
    });
    const orderJson = await orderResp.json();
    if (!orderResp.ok || !orderJson.id) {
      console.error("PayPal create order failed", orderJson);
      res.status(orderResp.status || 502).json({ error: "Could not start payment.", details: orderJson });
      return;
    }
    res.status(200).json({ id: orderJson.id });
  } catch (err) {
    console.error("PayPal create order error", err);
    res.status(502).json({ error: err.message || "Could not reach PayPal." });
  }
};
