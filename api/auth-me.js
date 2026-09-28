// api/auth-me.js
// Funzione serverless (Vercel) chiamata dal frontend a ogni apertura
// dell'app per capire se il visitatore ha già una sessione professionista
// attiva (cookie valido) e, in caso, restituire i suoi dati aggiornati
// (utile perché il piano/tier potrebbe essere cambiato nel frattempo).
// Se non c'è nessuna sessione valida, risponde semplicemente { user: null },
// che NON è un errore: succede per la maggior parte dei visitatori (privati
// o professionisti non ancora loggati).

const { getSupabaseConfig, supabaseRequest, readSessionCookie, verifySession, publicUser, sessionMatches, verifyPassword, clearSessionCookie, stripeRequest, paymentsEnabled } = require("./_auth-lib");

// ELIMINAZIONE ACCOUNT (POST /api/auth-me?action=delete, con la password):
// obbligatoria per App Store e Google Play e prevista dal GDPR.
// 1) disdice subito tutti gli abbonamenti Stripe (le fatture restano su Stripe,
//    vanno conservate per legge); 2) cancella foto e loghi dallo Storage;
//    3) le richieste dei clienti ancora aperte verso questo artigiano diventano
//    "rifiutata"; 4) cancella l'account: progetti, preventivi e richieste inviate
//    spariscono insieme (on delete cascade nel database).
const STORAGE_BUCKET = "project-photos";
async function storageList(prefix) {
  const { url, key } = getSupabaseConfig();
  const names = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const r = await fetch(url + "/storage/v1/object/list/" + STORAGE_BUCKET, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: prefix, limit: 1000, offset: offset }),
    });
    if (!r.ok) throw new Error("storage list " + r.status);
    const items = await r.json();
    (items || []).forEach(function (it) { if (it && it.name && it.id) names.push(prefix + "/" + it.name); });
    if (!items || items.length < 1000) break;
  }
  return names;
}
async function storageRemove(paths) {
  const { url, key } = getSupabaseConfig();
  for (let i = 0; i < paths.length; i += 500) {
    const r = await fetch(url + "/storage/v1/object/" + STORAGE_BUCKET, {
      method: "DELETE",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: paths.slice(i, i + 500) }),
    });
    if (!r.ok) throw new Error("storage delete " + r.status);
  }
}
async function deleteAccount(req, res) {
  const token = readSessionCookie(req);
  const session = token ? verifySession(token) : null;
  if (!session || !session.sub) return res.status(401).json({ error: "Accedi di nuovo per eliminare l'account." });
  const found = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(session.sub) + "&select=*", { method: "GET" });
  const row = found.ok && Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
  if (!row || !sessionMatches(session, row)) return res.status(401).json({ error: "Accedi di nuovo per eliminare l'account." });
  const body = req.body || {};
  const password = String(body.password || "");
  if (!password || !verifyPassword(password, row.password_salt, row.password_hash)) {
    return res.status(403).json({ error: "Password non corretta." });
  }
  const id = row.id;

  // 1) Abbonamenti: si leggono da Stripe (non dal database, che potrebbe non
  //    essere aggiornato) e si disdicono tutti quelli non ancora chiusi.
  //    Se non ci si riesce, l'account NON viene eliminato.
  if (row.stripe_customer_id || row.stripe_subscription_id) {
    if (!paymentsEnabled()) return res.status(409).json({ error: "Non riesco a disdire l'abbonamento in questo momento. Scrivi a info@rendrum.com." });
    let subs = [];
    if (row.stripe_customer_id) {
      const lr = await stripeRequest("GET", "/subscriptions?customer=" + encodeURIComponent(row.stripe_customer_id) + "&status=all&limit=100");
      if (!lr.ok || !lr.data || !Array.isArray(lr.data.data)) return res.status(502).json({ error: "Non riesco a controllare l'abbonamento: riprova tra qualche minuto. Il tuo account non è stato eliminato." });
      subs = lr.data.data;
    } else {
      const gr = await stripeRequest("GET", "/subscriptions/" + encodeURIComponent(row.stripe_subscription_id));
      if (gr.ok && gr.data) subs = [gr.data];
      else if (!(gr.data && gr.data.error && gr.data.error.code === "resource_missing")) return res.status(502).json({ error: "Non riesco a controllare l'abbonamento: riprova tra qualche minuto. Il tuo account non è stato eliminato." });
    }
    for (const sub of subs) {
      if (!sub || ["canceled", "incomplete_expired"].includes(sub.status)) continue;
      const sr = await stripeRequest("DELETE", "/subscriptions/" + encodeURIComponent(sub.id));
      if (!sr.ok) return res.status(502).json({ error: "Non riesco a disdire l'abbonamento: riprova tra qualche minuto. Il tuo account non è stato eliminato." });
    }
    // Pagamenti lasciati a metà: la pagina di pagamento non si potrà più completare.
    if (row.stripe_customer_id) {
      const cs = await stripeRequest("GET", "/checkout/sessions?customer=" + encodeURIComponent(row.stripe_customer_id) + "&status=open&limit=100");
      if (cs.ok && cs.data && Array.isArray(cs.data.data)) {
        for (const c of cs.data.data) await stripeRequest("POST", "/checkout/sessions/" + encodeURIComponent(c.id) + "/expire");
      }
    }
    await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ subscription_status: "canceled" }) }).catch(function () {});
  }

  // 2) Foto e loghi: se lo Storage non risponde ci fermiamo, così nessuna foto
  //    resta online senza più un account (si può riprovare).
  try {
    let paths = [];
    for (const prefix of [id, "profiles/" + id, "logos/" + id, "quotes/" + id, "leads/" + id]) {
      paths = paths.concat(await storageList(prefix));
    }
    if (paths.length) await storageRemove(paths);
  } catch (e) {
    console.error("delete-account storage", id, e && e.message);
    return res.status(502).json({ error: "Non riesco a cancellare le tue foto in questo momento: riprova tra qualche minuto. Il tuo account non è stato eliminato." });
  }

  // 3) Richieste dei clienti ancora aperte verso questo artigiano.
  await supabaseRequest("/pro_leads?artisan_id=eq." + encodeURIComponent(id) + "&status=in.(nuova,vista,preventivo_inviato)", {
    method: "PATCH", body: JSON.stringify({ status: "rifiutata", updated_at: new Date().toISOString() }),
  }).catch(function () {});

  // 4) Account (progetti, preventivi e richieste inviate vanno via a cascata).
  const del = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id), { method: "DELETE" });
  if (!del.ok) return res.status(502).json({ error: "Errore durante l'eliminazione: riprova. Se il problema resta scrivi a info@rendrum.com." });
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  if (req.method === "POST" && req.query && req.query.action === "delete") {
    if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio account non configurato." });
    try { return await deleteAccount(req, res); }
    catch (err) { console.error("delete-account", err && err.message); return res.status(500).json({ error: "Errore imprevisto: il tuo account non è stato eliminato. Riprova." }); }
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Usa una richiesta GET" });
  }

  const { configured } = getSupabaseConfig();
  if (!configured) {
    // Non è un errore bloccante qui: semplicemente nessuno può essere loggato.
    return res.status(200).json({ user: null });
  }

  try {
    const token = readSessionCookie(req);
    const session = token ? verifySession(token) : null;
    if (!session || !session.sub) {
      return res.status(200).json({ user: null });
    }

    const found = await supabaseRequest(
      "/pro_accounts?id=eq." + encodeURIComponent(session.sub) + "&select=*",
      { method: "GET" }
    );
    const row = found.ok && Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
    if (!row || !sessionMatches(session, row)) return res.status(200).json({ user: null });
    return res.status(200).json({ user: publicUser(row) });
  } catch (err) {
    return res.status(200).json({ user: null });
  }
};
