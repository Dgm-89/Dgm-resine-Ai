// api/stripe.js
// Tutte le funzioni dei pagamenti in un unico file (così su Vercel conta come
// una sola funzione): /api/stripe?action=checkout | portal | webhook
const { PLANS, paymentsEnabled, stripeRequest, currentAccount, supabaseRequest } = require("./_auth-lib");

// api/stripe-checkout.js
// Crea la pagina di pagamento Stripe per l'abbonamento scelto e restituisce
// l'indirizzo a cui mandare il cliente. Serve essere loggati.

async function checkout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
  if (!paymentsEnabled()) return res.status(503).json({ error: "Pagamenti non ancora attivi (manca STRIPE_SECRET_KEY su Vercel)." });
  try {
    const acc = await currentAccount(req);
    if (!acc) return res.status(401).json({ error: "Accedi o registrati prima di attivare l'abbonamento." });
    const body = req.body || {};
    const tier = PLANS[body.tier] ? body.tier : (PLANS[acc.tier] ? acc.tier : "basic");
    const plan = PLANS[tier];
    const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);

    const params = {
      mode: "subscription",
      client_reference_id: acc.id,
      success_url: origin + "/?pagamento=ok",
      cancel_url: origin + "/?pagamento=annullato",
      allow_promotion_codes: "true",
      billing_address_collection: "required",
      tax_id_collection: { enabled: "true" },
      locale: "it",
      line_items: { 0: { quantity: 1, price_data: {
        currency: "eur", unit_amount: plan.priceCents, tax_behavior: "exclusive",
        recurring: { interval: "month" },
        product_data: { name: plan.name + " – " + plan.images + " anteprime AI al mese" },
      } } },
      metadata: { account_id: acc.id, tier: tier },
      subscription_data: { metadata: { account_id: acc.id, tier: tier } },
    };
    // IVA: con STRIPE_AUTOMATIC_TAX=1 (e Stripe Tax attivo) Stripe aggiunge da solo il 22%.
    if ((process.env.STRIPE_AUTOMATIC_TAX || "").trim() === "1") params.automatic_tax = { enabled: "true" };
    if (acc.stripe_customer_id) params.customer = acc.stripe_customer_id;
    else params.customer_email = acc.email;
    if (acc.stripe_customer_id) params.customer_update = { address: "auto", name: "auto" };

    const r = await stripeRequest("POST", "/checkout/sessions", params);
    if (!r.ok || !r.data || !r.data.url) {
      return res.status(502).json({ error: "Stripe non ha creato la pagina di pagamento.", details: r.data && r.data.error ? r.data.error.message : r.data });
    }
    if (tier !== acc.tier) await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(acc.id), { method: "PATCH", body: JSON.stringify({ tier }) });
    return res.status(200).json({ url: r.data.url });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto", details: String(err && err.message || err) });
  }
}

// api/stripe-portal.js
// Apre il "portale cliente" di Stripe: il cliente può cambiare carta,
// scaricare le fatture o disdire l'abbonamento da solo.

async function portal(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
  if (!paymentsEnabled()) return res.status(503).json({ error: "Pagamenti non ancora attivi." });
  try {
    const acc = await currentAccount(req);
    if (!acc) return res.status(401).json({ error: "Accedi prima." });
    if (!acc.stripe_customer_id) return res.status(400).json({ error: "Non hai ancora un abbonamento attivo." });
    const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const r = await stripeRequest("POST", "/billing_portal/sessions", { customer: acc.stripe_customer_id, return_url: origin + "/" });
    if (!r.ok || !r.data || !r.data.url) return res.status(502).json({ error: "Impossibile aprire la gestione abbonamento.", details: r.data && r.data.error ? r.data.error.message : r.data });
    return res.status(200).json({ url: r.data.url });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto", details: String(err && err.message || err) });
  }
}

// api/stripe-webhook.js
// Stripe chiama questo indirizzo quando un pagamento va a buon fine, quando
// l'abbonamento si rinnova, non viene pagato o viene disdetto.
// Sicurezza: non ci fidiamo del contenuto ricevuto, ma rileggiamo l'evento
// direttamente da Stripe con la chiave segreta (così un falso avviso non ha effetto).

async function updateAccount(filter, fields) {
  return supabaseRequest("/pro_accounts?" + filter, { method: "PATCH", body: JSON.stringify(fields) });
}

async function webhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  if (!paymentsEnabled()) return res.status(200).json({ ignored: true });
  try {
    const incoming = req.body || {};
    if (!incoming.id) return res.status(400).json({ error: "evento senza id" });
    const ev = await stripeRequest("GET", "/events/" + encodeURIComponent(incoming.id));
    if (!ev.ok || !ev.data) return res.status(400).json({ error: "evento non trovato su Stripe" });
    const type = ev.data.type, obj = ev.data.data && ev.data.data.object ? ev.data.data.object : {};

    if (type === "checkout.session.completed" && obj.mode === "subscription") {
      const accountId = obj.client_reference_id || (obj.metadata && obj.metadata.account_id);
      const tier = obj.metadata && PLANS[obj.metadata.tier] ? obj.metadata.tier : undefined;
      if (accountId) await updateAccount("id=eq." + encodeURIComponent(accountId), {
        stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription,
        subscription_status: "active", tier,
      });
    } else if (type === "customer.subscription.updated" || type === "customer.subscription.deleted" || type === "customer.subscription.created") {
      const status = type === "customer.subscription.deleted" ? "canceled" : obj.status; // active, trialing, past_due, unpaid, canceled…
      const tier = obj.metadata && PLANS[obj.metadata.tier] ? obj.metadata.tier : undefined;
      const periodEnd = obj.current_period_end || (obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].current_period_end);
      await updateAccount("stripe_customer_id=eq." + encodeURIComponent(obj.customer), {
        subscription_status: status, stripe_subscription_id: obj.id, tier,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
      });
    } else if (type === "invoice.payment_failed") {
      await updateAccount("stripe_customer_id=eq." + encodeURIComponent(obj.customer), { subscription_status: "past_due" });
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";
  if (action === "checkout") return checkout(req, res);
  if (action === "portal") return portal(req, res);
  if (action === "webhook") return webhook(req, res);
  return res.status(404).json({ error: "Azione sconosciuta" });
};
