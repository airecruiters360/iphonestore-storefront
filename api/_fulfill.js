// api/_fulfill.js - shared order fulfillment + logging for PayPal and Affirm
// captures. Files starting with "_" are NOT exposed as endpoints by Vercel.
//
// What happens after a successful payment capture:
//   1. For each DEVICE in the order: find a matching In Stock unit at the
//      iPhoneStore.io store, create a Device invoice for it in the hub
//      (the invoices insert trigger marks the unit Sold - same path the
//      in-store Sell flow uses), and record its IMEI.
//   2. For each ACCESSORY: if the UPC exists in accessories_inventory at the
//      store, create an Accessory invoice (trigger decrements stock).
//   3. Log one storefront_inquiries row per item with customer info, amounts,
//      processor fee / net payout, and the IMEI folded into the message.
//
// Inventory writes require SUPABASE_SERVICE_ROLE_KEY in the environment.
// Without it, payments still complete and orders still get logged - the
// inventory just isn't auto-adjusted (a warning is folded into the order
// message so nothing slips through silently).

const SUPABASE_URL = "https://xggkxvecfrdtiakkwdgp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhnZ2t4dmVjZnJkdGlha2t3ZGdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTMxMjAsImV4cCI6MjA5ODY2OTEyMH0.s9ERsiEJJTTeXUJHQ6CL9hHSbtJ5FpqgXLu_Hjku-_g";

function headersFor(key) {
  return {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

async function sbSelect(key, pathAndQuery) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: headersFor(key) });
  if (!resp.ok) {
    console.error("Supabase select failed", pathAndQuery, await resp.text());
    return null;
  }
  return resp.json();
}

async function sbInsert(key, table, row) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headersFor(key), Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    console.error("Supabase insert failed", table, await resp.text());
    return false;
  }
  return true;
}

async function sbRpc(key, fn, args) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headersFor(key),
    body: JSON.stringify(args || {}),
  });
  if (!resp.ok) {
    console.error("Supabase rpc failed", fn, await resp.text());
    return null;
  }
  return resp.json();
}

async function iphoneStoreId(svcKey) {
  const rows = await sbSelect(svcKey, "stores?brand=eq.iPhoneStore.io&select=id&limit=1");
  return rows && rows[0] ? rows[0].id : null;
}

// Picks the oldest matching In Stock unit and creates the Device invoice that
// marks it Sold. Returns { imei, note }.
async function fulfillDevice(svcKey, storeId, item, customer, paymentMethod) {
  if (!svcKey || !storeId) return { imei: null, note: "INVENTORY NOT ADJUSTED (service key missing)" };
  let q =
    `inventory_units?select=id,imei&status=eq.${encodeURIComponent("In Stock")}` +
    `&store_id=eq.${storeId}&device_catalog_id=eq.${encodeURIComponent(item.device_catalog_id || "")}` +
    `&order=received_date.asc&limit=1`;
  if (item.condition_grade) q += `&condition_grade=eq.${encodeURIComponent(item.condition_grade)}`;
  let units = await sbSelect(svcKey, q);
  if ((!units || units.length === 0) && item.condition_grade) {
    // Fall back to any grade rather than failing the whole fulfillment.
    units = await sbSelect(
      svcKey,
      `inventory_units?select=id,imei&status=eq.${encodeURIComponent("In Stock")}` +
        `&store_id=eq.${storeId}&device_catalog_id=eq.${encodeURIComponent(item.device_catalog_id || "")}` +
        `&order=received_date.asc&limit=1`,
    );
  }
  const unit = units && units[0];
  if (!unit) return { imei: null, note: "INVENTORY NOT ADJUSTED (no matching In Stock unit found)" };

  const invNum = await sbRpc(svcKey, "get_next_invoice_number", {});
  const ok = await sbInsert(svcKey, "invoices", {
    invoice_number: typeof invNum === "string" ? invNum : "",
    sale_type: "Device",
    inventory_unit_id: unit.id,
    customer_name: customer.name || "Online order",
    customer_phone: customer.phone || "N/A",
    sale_channel: "Retail",
    payment_method: paymentMethod,
    unit_price: item.charged || 0,
    total_amount: item.charged || 0,
    tax_amount: 0,
    store_id: storeId,
    rep_id: null,
  });
  if (!ok) return { imei: unit.imei, note: "IMEI reserved but invoice insert failed - check manually" };
  return { imei: unit.imei, note: null };
}

async function fulfillAccessory(svcKey, storeId, item, customer, paymentMethod) {
  if (!svcKey || !storeId || !item.upc) return { note: "INVENTORY NOT ADJUSTED" };
  const rows = await sbSelect(
    svcKey,
    `accessories_inventory?select=id,quantity_on_hand&store_id=eq.${storeId}&upc=eq.${encodeURIComponent(item.upc)}&limit=1`,
  );
  const acc = rows && rows[0];
  if (!acc) return { note: `UPC ${item.upc} not in accessories inventory - stock not adjusted` };
  const invNum = await sbRpc(svcKey, "get_next_invoice_number", {});
  const ok = await sbInsert(svcKey, "invoices", {
    invoice_number: typeof invNum === "string" ? invNum : "",
    sale_type: "Accessory",
    accessory_item_id: acc.id,
    quantity: item.qty || 1,
    customer_name: customer.name || "Online order",
    customer_phone: customer.phone || "N/A",
    sale_channel: "Retail",
    payment_method: paymentMethod,
    unit_price: item.charged || 0,
    total_amount: (item.charged || 0) * (item.qty || 1),
    tax_amount: 0,
    store_id: storeId,
    rep_id: null,
  });
  return { note: ok ? null : "Accessory invoice insert failed - stock not adjusted" };
}

/**
 * Main entry. `payment` = { id, method, gross, fee, net, feeNote }.
 * `meta` = { items: [...], customer/shipping fields, pay_mode }.
 */
async function fulfillAndLogOrder(payment, meta) {
  const m = meta || {};
  const items = Array.isArray(m.items) ? m.items : [];
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  const storeId = svcKey ? await iphoneStoreId(svcKey) : null;

  const customer = { name: m.customer_name, phone: m.customer_phone, email: m.customer_email };
  const shippingLine = [m.shipping_address1, m.shipping_address2, m.shipping_city, m.shipping_state, m.shipping_zip]
    .filter(Boolean)
    .join(", ");
  const feeText =
    payment.fee != null ? `fee $${Number(payment.fee).toFixed(2)}` : payment.feeNote || "fee n/a";
  const netText = payment.net != null ? `net $${Number(payment.net).toFixed(2)}` : "net n/a";
  const orderLine = `Order ${payment.id}: total $${Number(payment.gross).toFixed(2)}, ${feeText}, ${netText}`;

  for (const item of items) {
    let imei = null;
    let note = null;
    if (item.type === "device") {
      const r = await fulfillDevice(svcKey, storeId, item, customer, payment.method);
      imei = r.imei;
      note = r.note;
    } else {
      const r = await fulfillAccessory(svcKey, storeId, item, customer, payment.method);
      note = r.note;
    }

    const extras = [
      shippingLine ? `Ship to: ${shippingLine}` : null,
      item.bundle_label ? `Bundle: ${item.bundle_label}` : null,
      item.warranty_label ? `Warranty: ${item.warranty_label}` : null,
      imei ? `IMEI: ${imei}` : null,
      item.upc ? `UPC: ${item.upc}` : null,
      m.pay_mode ? `Pay mode: ${m.pay_mode}` : null,
      orderLine,
      note,
    ]
      .filter(Boolean)
      .join(" | ");
    const combinedMessage = [m.message, extras].filter(Boolean).join(" || ") || null;

    await sbInsert(SUPABASE_ANON_KEY && svcKey ? svcKey : SUPABASE_ANON_KEY, "storefront_inquiries", {
      listing_id: item.listing_id || null,
      device_catalog_id: item.device_catalog_id || null,
      product_name: item.product_name || item.name || null,
      color: item.color || null,
      storage: item.storage || null,
      condition_grade: item.condition_grade || null,
      retail_price: item.charged != null ? Number(item.charged) : null,
      customer_name: m.customer_name || "Online checkout",
      customer_phone: m.customer_phone || null,
      customer_email: m.customer_email || null,
      message: combinedMessage,
      accessory_bundle: item.bundle_label || null,
      accessory_bundle_price: item.bundle_price != null && item.bundle_price !== "" ? Number(item.bundle_price) : null,
      payment_method: payment.method,
      payment_status: "succeeded",
      amount_charged: item.charged != null ? Number(item.charged) : null,
      stripe_payment_intent_id: payment.id,
    });
  }
}

module.exports = { fulfillAndLogOrder };
