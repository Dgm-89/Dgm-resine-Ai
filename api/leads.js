// api/leads.js — "Trova il tuo artigiano": richieste dei clienti e preventivi ricevuti.
// Cliente (privato):
//   POST /api/leads?action=create        -> invia la richiesta agli artigiani scelti dal cliente (o lista d'attesa)
//   GET  /api/leads?action=mine          -> le mie richieste con stato e preventivi ricevuti
//   GET  /api/leads?action=quote&id=     -> preventivo ricevuto (dati per il PDF)
//   POST /api/leads?action=accept        -> { id } accetta il preventivo
//   POST /api/leads?action=vote          -> { id, stelle, motivi } voto all'artigiano (solo preventivo accettato, una volta)
//   POST /api/leads?action=vote-skip     -> { id } "Salta": non lo chiediamo più
//   POST /api/leads?action=report        -> { artisanId, testo } segnala un problema su una ditta (email a Rendrum)
// Tutti:
//   GET  /api/leads?action=feedback-status -> { done } ha già votato Rendrum?
//   POST /api/leads?action=feedback      -> { stelle|null, motivi, testo } voto a Rendrum (una volta sola)
// Professionista:
//   GET  /api/leads?action=pro-list      -> richieste ricevute
//   GET  /api/leads?action=pro-get&id=   -> dettaglio (la segna come vista)
//   POST /api/leads?action=pro-decline   -> { id } non mi interessa
//   POST /api/leads?action=pro-send      -> { id, quoteId } invia il preventivo al cliente
// Controllo automatico (Vercel Cron, una volta al giorno):
//   GET  /api/leads?action=cron48        -> richieste senza preventivo dopo 48 ore: avvisa Rendrum e il cliente
// Tabella: vedi supabase_richieste.sql
const { currentAccount, supabaseRequest, getSupabaseConfig, paymentsEnabled, emailEnabled, sendEmail, emailLayout, siteOrigin } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");
const { GEO, provinceIndex } = require("./_geo");

const LAVORAZIONI = ["monolith", "microcemento", "scale", "imbiancatura", "resina_haccp", "spc", "laminato", "parquet", "piastrelle", "graniglia_esterni"];
const LAV_NOME = { monolith: "Resine", microcemento: "Microcemento", scale: "Scale", imbiancatura: "Imbiancatura", resina_haccp: "Resina industriale HACCP", spc: "SPC", laminato: "Laminato", parquet: "Parquet", piastrelle: "Piastrelle", graniglia_esterni: "Graniglia per esterni" };
const TIPI = ["Appartamento", "Casa indipendente / villa", "Negozio / ufficio", "Capannone / industriale", "Locale alimentare / ristorazione", "Condominio (parti comuni)"];
const STATI = ["Da rinnovare: c'è un pavimento/rivestimento da rimuovere", "Da rinnovare: posa sopra l'esistente", "Grezzo / nuova costruzione", "Solo pareti / tinteggiatura"];
const QUANDO = ["Entro 1 mese", "Tra 1 e 3 mesi", "Tra 3 e 6 mesi", "Oltre 6 mesi"];
const BUDGET = ["Fino a 2.000 €", "2.000 – 5.000 €", "5.000 – 10.000 €", "10.000 – 25.000 €", "Oltre 25.000 €"];

function str(v, max) { return String(v == null ? "" : v).replace(/[<>\u0000-\u001F]/g, " ").trim().slice(0, max); }
function uuid(v) { const s = String(v || "").toLowerCase(); return /^[0-9a-f-]{36}$/.test(s) ? s : ""; }
function esc(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
async function notify(to, subject, title, text, label, url) {
  if (!emailEnabled() || !to) return false;
  try { return await sendEmail(to, subject, emailLayout(title, text, label, url)); } catch (e) { console.error("leads email", e); return false; }
}
async function artisansFor(country, prov, lav) {
  let q = "/pro_accounts?select=id,email,company_name,logo_url,profile_city,tier,subscription_status,account_type"
    + "&profile_public=eq.true&profile_country=eq." + country
    + "&profile_provinces=cs." + encodeURIComponent("{" + prov + "}")
    + "&profile_lavorazioni=cs." + encodeURIComponent("{" + lav + "}");
  if (paymentsEnabled()) q += "&subscription_status=in.(active,trialing)";
  const r = await supabaseRequest(q, { method: "GET" });
  return r.ok && Array.isArray(r.data) ? r.data.filter(a => a.account_type !== "privato") : [];
}
// Casella di Rendrum per le richieste che nessuna ditta prende in carico
function adminEmail() { return (process.env.LEADS_ADMIN_EMAIL || process.env.REQUEST_TO || "info@rendrum.com").trim(); }
function publicSite() { return (process.env.SITE_URL || "https://www.rendrum.com").replace(/\/+$/, ""); }
function leadDetailsHtml(prov, lav, d) {
  const righe = [
    ["Lavorazione", LAV_NOME[lav] || lav], ["Zona", (d.comune || "") + " (" + prov + ")"], ["Immobile", d.tipo], ["Stato attuale", d.stato],
    ["Metri quadri", d.mq ? d.mq + " m²" : ""], ["Quando", d.quando], ["Budget", d.budget], ["Cliente", d.nome], ["Telefono", d.telefono], ["Email", d.email],
    ["Descrizione", d.descrizione], ["Scelte", (d.scelte || []).join(" · ")], ["Foto originale", d.prima ? '<a href="' + esc(d.prima) + '">apri</a>' : ""],
    ["Anteprima", d.dopo ? '<a href="' + esc(d.dopo) + '">apri</a>' : ""],
  ].filter(r => r[1]);
  return righe.map(r => "<b>" + esc(r[0]) + ":</b> " + (/^<a /.test(r[1]) ? r[1] : esc(r[1]))).join("<br>");
}
async function cron48(req, res) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return res.status(500).json({ error: "CRON_SECRET non configurato." });
  if ((req.headers.authorization || "") !== "Bearer " + secret) return res.status(401).json({ error: "Non autorizzato" });
  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const to = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const r = await supabaseRequest("/pro_leads?created_at=gte." + encodeURIComponent(from) + "&created_at=lte." + encodeURIComponent(to)
    + "&select=id,group_id,status,province,lavorazione,data,created_at&order=created_at.asc&limit=2000", { method: "GET" });
  if (!r.ok || !Array.isArray(r.data)) return res.status(502).json({ error: "Lettura non riuscita" });
  const groups = {};
  r.data.forEach(x => { (groups[x.group_id] = groups[x.group_id] || []).push(x); });
  let avvisi = 0;
  for (const gid of Object.keys(groups)) {
    const rows = groups[gid];
    const d = rows[0].data || {};
    if (rows.some(x => x.data && x.data.avviso48)) continue;                                   // già avvisato
    if (rows.every(x => x.status === "in_attesa")) continue;                                  // lista d'attesa: Rendrum è già stato avvisato all'invio
    if (rows.some(x => x.status === "preventivo_inviato" || x.status === "accettata")) continue; // qualcuno ha risposto
    const lavN = LAV_NOME[rows[0].lavorazione] || rows[0].lavorazione;
    const rifiutate = rows.filter(x => x.status === "rifiutata").length;
    await notify(adminEmail(), "Richiesta senza preventivo da 48 ore: " + lavN + " a " + (d.comune || rows[0].province),
      "Nessuna ditta ha ancora risposto",
      "Il cliente l'ha inviata a " + rows.length + " ditt" + (rows.length === 1 ? "a" : "e") + (rifiutate ? " (" + rifiutate + " non interessat" + (rifiutate === 1 ? "a" : "e") + ")" : "") + ", ma dopo 48 ore nessuna ha mandato un preventivo.<br><br>" + leadDetailsHtml(rows[0].province, rows[0].lavorazione, d),
      "Apri Rendrum", publicSite());
    await notify(d.email, "La tua richiesta per " + lavN + " – Rendrum", "Nessun preventivo, per ora",
      "Le ditte che hai scelto non hanno ancora risposto alla tua richiesta per <b>" + esc(lavN) + "</b>. Se vuoi, puoi inviarla anche ad altri artigiani della tua zona: apri la tua anteprima e tocca <b>Trova un artigiano</b>. Ti avvisiamo appena arriva un preventivo.",
      "Le mie richieste", publicSite() + "/?vai=richieste");
    await Promise.all(rows.map(x => supabaseRequest("/pro_leads?id=eq." + x.id, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ data: Object.assign({}, x.data || {}, { avviso48: new Date().toISOString() }) }) })));
    avvisi++;
  }
  return res.status(200).json({ ok: true, avvisi });
}

function leadForPro(row, full) {
  const d = row.data || {};
  const out = {
    id: row.id, status: row.status, createdAt: row.created_at, lavorazione: row.lavorazione, lavorazioneNome: LAV_NOME[row.lavorazione] || row.lavorazione,
    provincia: row.province, comune: d.comune, mq: d.mq, tipo: d.tipo, quando: d.quando, budget: d.budget, quoteId: row.quote_id || null,
    interesse: d.interesse || null, fase: d.fase || null, contatto: d.contatto || null, extra: d.extra || [],
  };
  if (full) Object.assign(out, { stato: d.stato, descrizione: d.descrizione, scelte: d.scelte || [], prima: d.prima || null, dopo: d.dopo || null,
    nome: d.nome, telefono: d.telefono, email: d.email });
  return out;
}

module.exports = async function handler(req, res) {
  if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio non configurato." });
  const action = (req.query && req.query.action) || "";
  try {
    if (action === "cron48") return await cron48(req, res);
    const acc = await currentAccount(req).catch(() => null);
    if (!acc) return res.status(401).json({ error: "Accedi al tuo account.", code: "login_required" });
    const isPro = acc.account_type !== "privato";
    const origin = siteOrigin(req);

    // ---------------- VOTO A RENDRUM (clienti e artigiani) ----------------
    if (action === "feedback-status" || action === "feedback") {
      const prev = await supabaseRequest("/rendrum_feedback?account_id=eq." + acc.id + "&select=id&limit=1", { method: "GET" });
      const done = prev.ok && Array.isArray(prev.data) && prev.data.length > 0;
      if (action === "feedback-status") return res.status(200).json({ done: done || !prev.ok });   // tabella assente: non chiediamo
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      if (!prev.ok) return res.status(200).json({ ok: true, stored: false });
      if (done) return res.status(409).json({ error: "Hai già votato, grazie!" });
      const b = req.body || {};
      const stelle = b.stelle == null ? null : Math.round(+b.stelle);
      if (stelle != null && !(stelle >= 1 && stelle <= 5)) return res.status(400).json({ error: "Voto non valido." });
      const motivi = (Array.isArray(b.motivi) ? b.motivi : []).slice(0, 6).map(x => str(x, 60)).filter(Boolean);
      const testo = str(b.testo, 1000);
      const ins = await supabaseRequest("/rendrum_feedback", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ account_id: acc.id, stelle, motivi, testo: testo || null }) });
      if (!ins.ok) return res.status(502).json({ error: "Invio non riuscito. Riprova." });
      if (stelle != null && stelle <= 3) {
        await notify(adminEmail(), "Voto a Rendrum: " + stelle + " stelle", "Un utente ha dato " + stelle + " stell" + (stelle === 1 ? "a" : "e") + " a Rendrum",
          "<b>" + esc(acc.email) + "</b> (" + (isPro ? "artigiano" : "cliente") + ")<br>Cosa non va: " + esc(motivi.join(", ") || "—") + (testo ? "<br><br>“" + esc(testo) + "”" : ""), "Apri Rendrum", publicSite());
      }
      return res.status(200).json({ ok: true, stored: true });
    }

    // ---------------- CLIENTE ----------------
    if (action === "vote" || action === "vote-skip") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      if (isPro) return res.status(403).json({ error: "Sezione riservata ai clienti." });
      const b = req.body || {};
      const id = uuid(b.id);
      const r = await supabaseRequest("/pro_leads?id=eq." + id + "&client_id=eq." + acc.id + "&select=*", { method: "GET" });
      const lead = r.ok && Array.isArray(r.data) && r.data[0];
      if (!lead || lead.status !== "accettata") return res.status(404).json({ error: "Puoi votare solo la ditta di cui hai accettato il preventivo." });
      const d = lead.data || {};
      if (d.voto) return res.status(409).json({ error: "Hai già votato questa ditta, grazie!" });
      const now = new Date().toISOString();
      if (action === "vote-skip") {
        if (!d.votoSkip) await supabaseRequest("/pro_leads?id=eq." + id, { method: "PATCH", body: JSON.stringify({ data: Object.assign({}, d, { votoSkip: now }) }) });
        return res.status(200).json({ ok: true });
      }
      const stelle = Math.round(+b.stelle);
      if (!(stelle >= 1 && stelle <= 5)) return res.status(400).json({ error: "Tocca una stella." });
      const motivi = stelle <= 2 ? (Array.isArray(b.motivi) ? b.motivi : []).slice(0, 6).map(x => str(x, 60)).filter(Boolean) : [];
      const u = await supabaseRequest("/pro_leads?id=eq." + id, { method: "PATCH", body: JSON.stringify({ data: Object.assign({}, d, { voto: { s: stelle, m: motivi, at: now } }) }) });
      if (!u.ok) return res.status(502).json({ error: "Voto non salvato. Riprova." });
      if (stelle <= 2) {
        const ar = await supabaseRequest("/pro_accounts?id=eq." + lead.artisan_id + "&select=company_name,email,phone", { method: "GET" });
        const a = (ar.ok && ar.data && ar.data[0]) || {};
        await notify(adminEmail(), "Voto basso: " + (a.company_name || "ditta") + " (" + stelle + "★)", "Un cliente ha dato " + stelle + " stell" + (stelle === 1 ? "a" : "e") + " a una ditta",
          "<b>Ditta:</b> " + esc(a.company_name) + " · " + esc(a.email) + " · " + esc(a.phone) + "<br><b>Cliente:</b> " + esc(d.nome) + " · " + esc(acc.email) + " · " + esc(d.telefono)
          + "<br><b>Lavoro:</b> " + esc(LAV_NOME[lead.lavorazione]) + " a " + esc(d.comune) + "<br><b>Cosa non è andato:</b> " + esc(motivi.join(", ") || "non indicato")
          + "<br><br>Il motivo lo vede solo Rendrum. Valuta se sentire la ditta.", "Apri Rendrum", publicSite());
      }
      return res.status(200).json({ ok: true });
    }
    if (action === "report") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const b = req.body || {};
      const aid = uuid(b.artisanId), testo = str(b.testo, 1500);
      if (!aid || testo.length < 10) return res.status(400).json({ error: "Scrivi in breve cosa è successo (almeno 10 caratteri)." });
      const ar = await supabaseRequest("/pro_accounts?id=eq." + aid + "&select=company_name,email,phone,profile_city", { method: "GET" });
      const a = ar.ok && ar.data && ar.data[0];
      if (!a) return res.status(404).json({ error: "Ditta non trovata." });
      const sent = await notify(adminEmail(), "Segnalazione su " + (a.company_name || "una ditta"), "Segnalazione di un utente",
        "<b>Ditta:</b> " + esc(a.company_name) + " (" + esc(a.profile_city) + ") · " + esc(a.email) + " · " + esc(a.phone)
        + "<br><b>Segnalata da:</b> " + esc(acc.email) + " (" + (isPro ? "artigiano" : "cliente") + ")<br><br>“" + esc(testo) + "”", "Apri Rendrum", publicSite());
      if (!sent && emailEnabled()) return res.status(502).json({ error: "Invio non riuscito. Riprova o scrivi a info@rendrum.com." });
      return res.status(200).json({ ok: true });
    }

    if (action === "create") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      if (isPro) return res.status(403).json({ error: "Le richieste agli artigiani si inviano da un account privato." });
      const b = req.body || {};
      const country = "IT";
      const prov = String(b.provincia || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
      const lav = String(b.lavorazione || "").replace(/[^a-z_]/g, "");
      const d = {
        comune: str(b.comune, 80), tipo: str(b.tipo, 80), stato: str(b.stato, 120), quando: str(b.quando, 40), budget: str(b.budget, 40),
        mq: Math.round(Math.max(0, Math.min(100000, Number(String(b.mq || "").replace(",", ".")) || 0)) * 10) / 10,
        descrizione: str(b.descrizione, 1500), nome: str(b.nome, 120), telefono: str(b.telefono, 30), email: acc.email,
        scelte: (Array.isArray(b.scelte) ? b.scelte : []).slice(0, 30).map(x => str(x, 300)).filter(Boolean),
      };
      // Questionario (fase, quando, lavori extra, contatto): i campi di dettaglio diventano facoltativi
      const q = (b.q && typeof b.q === "object") ? b.q : null, qOn = !!q;
      if (qOn) {
        const pick = (v, ok) => ok.includes(v) ? v : "";
        const fase = pick(q.fase, ["pronto", "preventivi", "idea"]), quandoQ = pick(q.quando, ["subito", "3mesi", "anno", "nodata"]), contatto = pick(q.contatto, ["whatsapp", "telefono", "email", "no"]);
        d.fase = ({ pronto: "Pronto a partire", preventivi: "Raccoglie preventivi", idea: "Si sta facendo un'idea" })[fase] || "";
        d.contatto = ({ whatsapp: "WhatsApp", telefono: "Telefonata", email: "Email", no: "Per ora no" })[contatto] || "";
        d.extra = (Array.isArray(b.qExtra) ? b.qExtra : []).slice(0, 8).map(x => str(x, 120)).filter(Boolean);
        d.interesse = (fase === "idea" || contatto === "no") ? "basso" : ((fase === "pronto" || fase === "preventivi") && (quandoQ === "subito" || quandoQ === "3mesi") && contatto) ? "alto" : "medio";
        if (d.interesse === "basso") return res.status(200).json({ ok: true, sent: 0, saved: true, skipped: true });
      }
      const errs = [];
      if (!provinceIndex(country)[prov]) errs.push("provincia");
      if (!LAVORAZIONI.includes(lav)) errs.push("lavorazione");
      if (d.comune.length < 2) errs.push("comune");
      if (!TIPI.includes(d.tipo) && !(qOn && !d.tipo)) errs.push("tipo di immobile");
      if (!STATI.includes(d.stato) && !(qOn && !d.stato)) errs.push("stato attuale");
      if (!(d.mq > 0) && !qOn) errs.push("metri quadri");
      if (!QUANDO.includes(d.quando)) errs.push("quando vuoi iniziare");
      if (d.budget && !BUDGET.includes(d.budget)) d.budget = "";   // il budget non si chiede più al cliente
      if (d.descrizione.length < 20 && !qOn) errs.push("descrizione del lavoro (almeno 20 caratteri)");
      if (d.nome.length < 3) errs.push("nome e cognome");
      if (d.telefono.replace(/\D/g, "").length < 8) errs.push("telefono");
      if (!b.privacy || !b.condividi) errs.push("consensi");
      if (errs.length) return res.status(400).json({ error: "Completa: " + errs.join(", ") + "." });

      // Limite anti-abuso: al massimo 10 invii nelle ultime 24 ore
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const recent = await supabaseRequest("/pro_leads?client_id=eq." + acc.id + "&created_at=gte." + encodeURIComponent(since) + "&select=id", { method: "GET" });
      if (recent.ok && Array.isArray(recent.data) && recent.data.length >= 10) return res.status(429).json({ error: "Hai inviato molte richieste oggi. Riprova domani." });

      // Artigiani scelti: devono essere visibili per quella provincia e lavorazione
      const available = await artisansFor(country, prov, lav);
      const ids = Array.from(new Set((Array.isArray(b.artisans) ? b.artisans : []).map(uuid).filter(Boolean))).slice(0, 50);
      const chosen = available.filter(a => ids.includes(a.id));
      if (ids.length && chosen.length !== ids.length) return res.status(400).json({ error: "Uno degli artigiani scelti non è più disponibile. Aggiorna l'elenco." });
      if (!ids.length && available.length) return res.status(400).json({ error: "Scegli almeno un artigiano." });

      // Foto dell'anteprima (facoltative ma consigliate)
      if (b.prima || b.dopo) {
        const [p1, p2] = await Promise.all([uploadPhoto(b.prima, "leads/" + acc.id), uploadPhoto(b.dopo, "leads/" + acc.id)]);
        d.prima = p1 || null; d.dopo = p2 || null;
      }
      const group = require("crypto").randomUUID();
      const now = new Date().toISOString();
      const rows = (chosen.length ? chosen : [null]).map(a => ({
        group_id: group, client_id: acc.id, artisan_id: a ? a.id : null, status: a ? "nuova" : "in_attesa",
        country, province: prov, lavorazione: lav, data: d, created_at: now, updated_at: now,
      }));
      const ins = await supabaseRequest("/pro_leads", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });
      if (!ins.ok) { console.error("leads create", ins.data); return res.status(502).json({ error: "Invio non riuscito. Riprova." }); }

      const lavN = LAV_NOME[lav];
      await Promise.all(chosen.map(a => notify(a.email, "Nuova richiesta da Rendrum: " + lavN + " a " + d.comune,
        "Hai una nuova richiesta di lavoro",
        "Un cliente di <b>" + esc(d.comune) + " (" + prov + ")</b> ti ha scelto per <b>" + esc(lavN) + "</b>, circa " + d.mq + " m², inizio: " + esc(d.quando.toLowerCase()) + ". Trovi foto, dettagli e contatti nell'app.",
        "Apri la richiesta", origin + "/?vai=richieste")));
      await notify(acc.email, "Richiesta inviata – Rendrum", "Richiesta inviata",
        chosen.length ? "Abbiamo inviato la tua richiesta per <b>" + esc(lavN) + "</b> a " + chosen.map(a => "<b>" + esc(a.company_name) + "</b>").join(", ") + ". Ti avviseremo appena riceverai un preventivo."
          : "Al momento non ci sono artigiani per <b>" + esc(lavN) + "</b> nella provincia di " + prov + ". Ti avviseremo appena se ne iscrive uno.",
        "Le mie richieste", origin + "/?vai=richieste");
      if (!chosen.length) {
        await notify(adminEmail(), "Richiesta senza ditte in zona: " + lavN + " a " + d.comune + " (" + prov + ")",
          "Nessuna ditta iscritta in questa zona",
          "È arrivata una richiesta per <b>" + esc(lavN) + "</b> ma nella provincia di " + prov + " non c'è nessun artigiano iscritto per questo lavoro. Il cliente è in lista d'attesa.<br><br>" + leadDetailsHtml(prov, lav, d),
          "Apri Rendrum", publicSite());
      }
      return res.status(200).json({ ok: true, sent: chosen.length, waitlist: !chosen.length });
    }

    if (action === "mine") {
      if (isPro) return res.status(403).json({ error: "Sezione riservata ai clienti." });
      const r = await supabaseRequest("/pro_leads?client_id=eq." + acc.id + "&select=id,group_id,status,province,lavorazione,data,quote_id,created_at,updated_at,artisan_id&order=created_at.desc&limit=100", { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "Non riesco a caricare le richieste." });
      const rows = r.data || [];
      const artIds = Array.from(new Set(rows.map(x => x.artisan_id).filter(Boolean)));
      const qIds = Array.from(new Set(rows.map(x => x.quote_id).filter(Boolean)));
      const [arts, quotes] = await Promise.all([
        artIds.length ? supabaseRequest("/pro_accounts?id=in.(" + artIds.join(",") + ")&select=id,company_name,logo_url,profile_city,phone", { method: "GET" }) : { ok: true, data: [] },
        qIds.length ? supabaseRequest("/pro_quotes?id=in.(" + qIds.join(",") + ")&select=id,number,year,total_cents", { method: "GET" }) : { ok: true, data: [] },
      ]);
      const A = {}; (arts.data || []).forEach(a => { A[a.id] = a; });
      const Q = {}; (quotes.data || []).forEach(q => { Q[q.id] = q; });
      const groups = {};
      rows.forEach(x => {
        const d = x.data || {};
        const g = groups[x.group_id] = groups[x.group_id] || { id: x.group_id, createdAt: x.created_at, lavorazione: x.lavorazione, lavorazioneNome: LAV_NOME[x.lavorazione], provincia: x.province, comune: d.comune, mq: d.mq, dopo: d.dopo || null, artisans: [] };
        const a = x.artisan_id ? A[x.artisan_id] : null, q = x.quote_id ? Q[x.quote_id] : null;
        const withQuote = q && ["preventivo_inviato", "accettata"].includes(x.status);
        g.artisans.push({ leadId: x.id, artisanId: x.artisan_id || null, status: x.status, name: a ? a.company_name : null, logoUrl: a ? a.logo_url : null, city: a ? a.profile_city : null,
          canVote: x.status === "accettata" && !d.voto && !d.votoSkip, myVote: d.voto ? d.voto.s : null,
          acceptedAt: x.status === "accettata" ? x.updated_at : null,
          phone: withQuote && a ? a.phone : null,
          quote: withQuote ? { number: q.number, year: q.year, total: q.total_cents / 100 } : null });
      });
      return res.status(200).json({ requests: Object.values(groups) });
    }

    if (action === "quote" || action === "accept") {
      if (isPro) return res.status(403).json({ error: "Sezione riservata ai clienti." });
      const id = uuid(action === "quote" ? req.query.id : (req.body || {}).id);
      const r = await supabaseRequest("/pro_leads?id=eq." + id + "&client_id=eq." + acc.id + "&select=*", { method: "GET" });
      const lead = r.ok && Array.isArray(r.data) && r.data[0];
      if (!lead || !lead.quote_id || !["preventivo_inviato", "accettata"].includes(lead.status)) return res.status(404).json({ error: "Preventivo non disponibile." });
      const [qr, ar] = await Promise.all([
        supabaseRequest("/pro_quotes?id=eq." + lead.quote_id + "&account_id=eq." + lead.artisan_id + "&select=*", { method: "GET" }),
        supabaseRequest("/pro_accounts?id=eq." + lead.artisan_id + "&select=id,email,company_name,logo_url,quote_settings", { method: "GET" }),
      ]);
      const quote = qr.ok && qr.data && qr.data[0], art = ar.ok && ar.data && ar.data[0];
      if (!quote || !art) return res.status(404).json({ error: "Preventivo non disponibile." });
      if (action === "quote") {
        const s = art.quote_settings || {};
        return res.status(200).json({ number: quote.number, year: quote.year, quote: quote.data, status: lead.status,
          impresa: s.impresa || { ragioneSociale: art.company_name }, banca: s.banca || {}, logoUrl: art.logo_url || null });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      if (lead.status !== "accettata") {
        const now = new Date().toISOString();
        await supabaseRequest("/pro_leads?id=eq." + id, { method: "PATCH", body: JSON.stringify({ status: "accettata", updated_at: now }) });
        await supabaseRequest("/pro_quotes?id=eq." + quote.id, { method: "PATCH", body: JSON.stringify({ status: "accettato", updated_at: now }) });
        await notify(art.email, "Preventivo accettato – Rendrum", "Il cliente ha accettato il tuo preventivo",
          "Il cliente <b>" + esc((lead.data || {}).nome) + "</b> di " + esc((lead.data || {}).comune) + " ha accettato il preventivo n. " + ("00" + quote.number).slice(-3) + "/" + quote.year + ". Contattalo per fissare il sopralluogo e la firma.",
          "Apri la richiesta", origin + "/?vai=richieste");
      }
      return res.status(200).json({ ok: true });
    }

    // ---------------- PROFESSIONISTA ----------------
    if (!isPro) return res.status(403).json({ error: "Sezione riservata ai professionisti." });

    if (action === "pro-list") {
      const r = await supabaseRequest("/pro_leads?artisan_id=eq." + acc.id + "&select=id,status,province,lavorazione,data,quote_id,created_at&order=created_at.desc&limit=200", { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "Non riesco a caricare le richieste." });
      const list = (r.data || []).map(x => leadForPro(x, false));
      return res.status(200).json({ leads: list, nuove: list.filter(x => x.status === "nuova").length });
    }
    if (action === "pro-get") {
      const id = uuid(req.query.id);
      const r = await supabaseRequest("/pro_leads?id=eq." + id + "&artisan_id=eq." + acc.id + "&select=*", { method: "GET" });
      const lead = r.ok && Array.isArray(r.data) && r.data[0];
      if (!lead) return res.status(404).json({ error: "Richiesta non trovata." });
      if (lead.status === "nuova") {
        await supabaseRequest("/pro_leads?id=eq." + id, { method: "PATCH", body: JSON.stringify({ status: "vista", updated_at: new Date().toISOString() }) });
        lead.status = "vista";
      }
      return res.status(200).json({ lead: leadForPro(lead, true) });
    }
    if (action === "pro-decline" || action === "pro-send") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const b = req.body || {};
      const id = uuid(b.id);
      const r = await supabaseRequest("/pro_leads?id=eq." + id + "&artisan_id=eq." + acc.id + "&select=*", { method: "GET" });
      const lead = r.ok && Array.isArray(r.data) && r.data[0];
      if (!lead) return res.status(404).json({ error: "Richiesta non trovata." });
      if (lead.status === "accettata") return res.status(409).json({ error: "Il cliente ha già accettato il preventivo." });
      const now = new Date().toISOString();
      if (action === "pro-decline") {
        await supabaseRequest("/pro_leads?id=eq." + id, { method: "PATCH", body: JSON.stringify({ status: "rifiutata", updated_at: now }) });
        return res.status(200).json({ ok: true });
      }
      const qid = uuid(b.quoteId);
      const qr = await supabaseRequest("/pro_quotes?id=eq." + qid + "&account_id=eq." + acc.id + "&select=id,number,year,total_cents", { method: "GET" });
      const quote = qr.ok && qr.data && qr.data[0];
      if (!quote) return res.status(404).json({ error: "Salva prima il preventivo." });
      // Tempo di risposta (per il bollino "Risponde in fretta"): ore dalla richiesta al primo preventivo
      const ld = lead.data || {}, patch = { status: "preventivo_inviato", quote_id: quote.id, updated_at: now };
      if (ld.rispostaOre == null) patch.data = Object.assign({}, ld, { rispostaOre: Math.round((Date.now() - Date.parse(lead.created_at)) / 36e5 * 10) / 10 });
      await supabaseRequest("/pro_leads?id=eq." + id, { method: "PATCH", body: JSON.stringify(patch) });
      await supabaseRequest("/pro_quotes?id=eq." + quote.id, { method: "PATCH", body: JSON.stringify({ status: "inviato", updated_at: now }) });
      const cr = await supabaseRequest("/pro_accounts?id=eq." + lead.client_id + "&select=email", { method: "GET" });
      const cEmail = cr.ok && cr.data && cr.data[0] && cr.data[0].email;
      await notify(cEmail, "Hai ricevuto un preventivo – Rendrum", "Hai ricevuto un preventivo",
        "<b>" + esc(acc.company_name) + "</b> ti ha inviato il preventivo per <b>" + esc(LAV_NOME[lead.lavorazione]) + "</b>. Puoi vederlo, scaricarlo in PDF e accettarlo dall'app.",
        "Vedi il preventivo", origin + "/?vai=richieste");
      return res.status(200).json({ ok: true });
    }
    return res.status(404).json({ error: "Azione sconosciuta" });
  } catch (err) {
    console.error("leads", err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
module.exports.OPTIONS = { TIPI, STATI, QUANDO, BUDGET };
