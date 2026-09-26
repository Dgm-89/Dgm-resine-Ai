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
    // Abbonamento già attivo: niente secondo pagamento, si apre la gestione abbonamento.
    if (acc.stripe_customer_id && ["active", "trialing", "past_due"].includes(acc.subscription_status)) {
      const o = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
      const pr = await stripeRequest("POST", "/billing_portal/sessions", { customer: acc.stripe_customer_id, return_url: o + "/" });
      if (pr.ok && pr.data && pr.data.url) return res.status(200).json({ url: pr.data.url, portal: true });
      return res.status(409).json({ error: "Hai già un abbonamento attivo: gestiscilo dal pulsante Abbonamento." });
    }
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
      console.error("stripe checkout", r.data);
      return res.status(502).json({ error: "Stripe non ha creato la pagina di pagamento. Riprova tra poco." });
    }
    // Il piano NON si cambia qui: lo scrive solo il webhook quando Stripe conferma il pagamento.
    return res.status(200).json({ url: r.data.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova tra poco." });
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
    if (!r.ok || !r.data || !r.data.url) { console.error("stripe portal", r.data); return res.status(502).json({ error: "Impossibile aprire la gestione abbonamento. Riprova tra poco." }); }
    return res.status(200).json({ url: r.data.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova tra poco." });
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

    // Da quale abbonamento arriva l'evento?
    let subId = null, fallbackAccount = null;
    if (type === "checkout.session.completed" && obj.mode === "subscription") {
      subId = obj.subscription; fallbackAccount = obj.client_reference_id || (obj.metadata && obj.metadata.account_id);
    } else if (type.indexOf("customer.subscription.") === 0) {
      subId = obj.id;
    } else if (type === "invoice.payment_failed" || type === "invoice.paid") {
      subId = obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
    }
    if (!subId) return res.status(200).json({ ignored: true });

    // Non ci fidiamo dell'evento (può arrivare in ritardo o fuori ordine):
    // leggiamo da Stripe lo stato ATTUALE dell'abbonamento.
    const sr = await stripeRequest("GET", "/subscriptions/" + encodeURIComponent(subId));
    if (!sr.ok || !sr.data) return res.status(500).json({ error: "abbonamento non leggibile" });
    const sub = sr.data;
    const meta = sub.metadata || {};
    const accountId = meta.account_id || fallbackAccount;
    const filter = accountId ? "id=eq." + encodeURIComponent(accountId) : "stripe_customer_id=eq." + encodeURIComponent(sub.customer);
    const found = await supabaseRequest("/pro_accounts?" + filter + "&select=id,stripe_subscription_id,subscription_status", { method: "GET" });
    const acc = found.ok && Array.isArray(found.data) ? found.data[0] : null;
    if (!acc) return res.status(200).json({ ignored: "account non trovato" });

    const liveStatuses = ["active", "trialing"];
    // Se l'account ha già un ALTRO abbonamento attivo, un abbonamento chiuso non lo spegne.
    if (acc.stripe_subscription_id && acc.stripe_subscription_id !== sub.id && liveStatuses.includes(acc.subscription_status) && !liveStatuses.includes(sub.status)) {
      return res.status(200).json({ ignored: "altro abbonamento attivo" });
    }
    const item = sub.items && sub.items.data && sub.items.data[0];
    const periodEnd = sub.current_period_end || (item && item.current_period_end);
    const fields = {
      stripe_customer_id: sub.customer,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status === "incomplete_expired" ? "canceled" : sub.status,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    };
    if (PLANS[meta.tier] && liveStatuses.includes(sub.status)) fields.tier = meta.tier;
    await updateAccount("id=eq." + encodeURIComponent(acc.id), fields);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("webhook", err);
    return res.status(500).json({ error: "errore webhook" });
  }
}

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";
  if (action === "checkout") return checkout(req, res);
  if (action === "portal") return portal(req, res);
  if (action === "webhook") return webhook(req, res);
  return res.status(404).json({ error: "Azione sconosciuta" });
};
