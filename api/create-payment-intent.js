// Vercel serverless function: /api/create-payment-intent
//
// Creates a Stripe PaymentIntent for one of two pricing modes, set by
// the "paymentMode" field in the request body:
//   "full"       - card or Cash App Pay, at the discounted "pay in
//                  full" price computed client-side (list price - 7%)
//   "financing"  - Klarna, Afterpay, or Affirm, at the full list price
//
// The amount is trusted from the client in both modes (as before this
// change) - the discount math itself lives in index.html. This split
// exists only to restrict which payment_method_types are offered per
// mode, since a single PaymentIntent can't vary its amount per method.
//
// Required environment variable (set in Vercel Project Settings -
// never in this file or client-side code):
//   STRIPE_SECRET_KEY   - starts with sk_test_... in test mode,
//                         sk_live_... in live mode
//
// Uses Stripe's REST API directly via fetch (no stripe npm package),
// so no build step / dependency install is required for this repo.

module.exports = async function handler(req, res) {
      if (req.method !== "POST") {
              res.status(405).json({ error: "Method not allowed" });
              return;
      }

      const secretKey = process.env.STRIPE_SECRET_KEY;
      if (!secretKey) {
              res.status(500).json({
                        error:
                                    "Server is missing STRIPE_SECRET_KEY. Add it in Vercel Project Settings -> Environment Variables.",
              });
              return;
      }

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const {
              amount, // dollars, e.g. 649.00
              paymentMode, // "full" (card/cashapp, discounted) or "financing" (klarna/afterpay/affirm, list price)
              listingId,
              deviceCatalogId,
              productName,
              color,
              storage,
              conditionGrade,
              customerName,
              customerPhone,
              customerEmail,
              message,
              accessoryBundle,
              accessoryBundlePrice,
      } = body;

      if (!amount || Number(amount) <= 0) {
              res.status(400).json({ error: "Missing or invalid amount." });
              return;
      }

      const amountInCents = Math.round(Number(amount) * 100);

      const mode = paymentMode === "financing" ? "financing" : "full";
      const methodsByMode = {
              full: ["card", "cashapp"],
              financing: ["klarna", "afterpay_clearpay", "affirm"],
      };

      const params = new URLSearchParams();
      params.append("amount", String(amountInCents));
      params.append("currency", "usd");
      methodsByMode[mode].forEach((m) => params.append("payment_method_types[]", m));

      // Metadata rides along on the PaymentIntent so the webhook can log a
      // complete order without a separate lookup.
      const metadata = {
              payment_mode: mode,
              listing_id: listingId || "",
              device_catalog_id: deviceCatalogId || "",
              product_name: productName || "",
              color: color || "",
              storage: storage || "",
              condition_grade: conditionGrade || "",
              customer_name: customerName || "",
              customer_phone: customerPhone || "",
              customer_email: customerEmail || "",
              message: message || "",
              accessory_bundle: accessoryBundle || "",
              accessory_bundle_price: accessoryBundlePrice != null ? String(accessoryBundlePrice) : "",
      };
      Object.entries(metadata).forEach(([key, value]) => {
              params.append(`metadata[${key}]`, value);
      });

      try {
              const stripeResp = await fetch("https://api.stripe.com/v1/payment_intents", {
                        method: "POST",
                        headers: {
                                    Authorization: `Bearer ${secretKey}`,
                                    "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body: params.toString(),
              });
              const stripeJson = await stripeResp.json();

        if (!stripeResp.ok) {
                  console.error("Stripe create PaymentIntent failed", stripeJson);
                  res.status(stripeResp.status).json({ error: "Could not start payment.", details: stripeJson.error });
                  return;
        }

        res.status(200).json({ clientSecret: stripeJson.client_secret });
      } catch (err) {
              console.error("Stripe request error", err);
              res.status(502).json({ error: "Could not reach Stripe." });
      }
};
