// api/pro-profile.js
// Profilo pubblico dell'artigiano per "Trova il tuo artigiano".
//   GET  /api/pro-profile?action=me              -> profilo del professionista loggato
//   POST /api/pro-profile?action=save            -> salva il profilo (tutti i campi obbligatori)
//   GET  /api/pro-profile?action=list&country=IT&province=MI&lav=monolith
//                                                -> artigiani visibili che lavorano in quella provincia/lavorazione
//                                                   (con media stelle dei clienti e bollini automatici)
//   GET  /api/pro-profile?action=verify&id=&t=   -> link nell'email a Rendrum: assegna il bollino "P.IVA verificata"
// Colonne extra (piva_ok, declared_at, profile_google…): vedi supabase_voti.sql.
// Se il file SQL non è ancora stato eseguito, tutto continua a funzionare senza voti e bollini.
const crypto = require("crypto");
const { currentAccount, supabaseRequest, getSupabaseConfig, paymentsEnabled, emailEnabled, sendEmail, emailLayout, siteOrigin } = require("./_auth-lib");
const { vatCheck } = require("./_vat");
const { uploadPhoto } = require("./_projects-lib");
const { GEO, provinceIndex } = require("./_geo");

const LAVORAZIONI = ["monolith", "microcemento", "scale", "imbiancatura", "resina_haccp", "spc", "laminato", "parquet", "piastrelle", "graniglia_esterni"];
const TIER_RANK = { pro: 3, medium: 2, basic: 1 };

function clean(v, max) { return String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, max); }
function codeList(v, re, max) {
  return (Array.isArray(v) ? v : []).map(x => String(x).toUpperCase().trim()).filter(x => re.test(x)).slice(0, max);
}
const BASE_COLS = "id,company_name,logo_url,profile_bio,profile_city,profile_website,profile_country,profile_regions,profile_provinces,profile_lavorazioni,profile_gallery,profile_public,tier,subscription_status";
const NEW_COLS = ",piva_ok,profile_google,created_at";
const NEW_FIELDS = ["piva_ok", "piva_name", "piva_checked_at", "declared_at", "profile_google"];
const GOOGLE_RE = /^https:\/\/((www\.|maps\.)?google\.[a-z.]{2,6}|g\.page|maps\.app\.goo\.gl|goo\.gl|g\.co)\/\S*$/i;
const DAY = 24 * 3600 * 1000;

function adminEmail() { return (process.env.LEADS_ADMIN_EMAIL || process.env.REQUEST_TO || "info@rendrum.com").trim(); }
function esc(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function verifyToken(id) { return crypto.createHmac("sha256", String(getSupabaseConfig().jwtSecret || "rd")).update("piva:" + id).digest("hex").slice(0, 32); }
function missingColumn(r) { const t = JSON.stringify((r && r.data) || ""); return /PGRST204|42703|column/i.test(t); }
// PATCH che sopravvive se le colonne nuove non esistono ancora (SQL non eseguito)
async function patchAccount(id, fields) {
  const path = "/pro_accounts?id=eq." + encodeURIComponent(id);
  let u = await supabaseRequest(path, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) });
  if (!u.ok && missingColumn(u)) {
    const f2 = Object.assign({}, fields); NEW_FIELDS.forEach(k => delete f2[k]);
    u = await supabaseRequest(path, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(f2) });
  }
  return u;
}
// VIES (servizio gratuito UE): riconosce solo le partite IVA abilitate alle operazioni con l'estero.
async function viesCheck(country, number) {
  if (typeof fetch !== "function") return null;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const tm = ctl ? setTimeout(() => ctl.abort(), 6000) : null;
  try {
    const r = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/" + country + "/vat/" + encodeURIComponent(number), { signal: ctl ? ctl.signal : undefined, headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return { valid: j.isValid === true || j.valid === true, name: String(j.name || "").replace(/^-+$/, "").trim().slice(0, 160) };
  } catch (e) { return null; } finally { if (tm) clearTimeout(tm); }
}
// Prima pubblicazione del profilo: prova VIES, altrimenti chiede a Rendrum un controllo da 10 secondi.
async function pivaCheckOnce(acc, row, req) {
  if (!row || row.piva_ok !== false || row.piva_checked_at) return row;
  const ctry = String(row.profile_country || "IT").toUpperCase();
  const v = vatCheck(ctry, acc.piva || "");
  const eu = v.ok && !["XX", "CH", "GB", "SM"].includes(v.country);
  const res = eu ? await viesCheck(v.country === "GR" ? "EL" : v.country, v.number) : null;
  const now = new Date().toISOString();
  if (res && res.valid) {
    const u = await patchAccount(acc.id, { piva_ok: true, piva_name: res.name || null, piva_checked_at: now });
    return (u.ok && u.data && u.data[0]) || Object.assign({}, row, { piva_ok: true });
  }
  await patchAccount(acc.id, { piva_checked_at: now });
  if (emailEnabled()) {
    const link = siteOrigin(req) + "/api/pro-profile?action=verify&id=" + acc.id + "&t=" + verifyToken(acc.id);
    const txt = "Nuovo artigiano su Rendrum: <b>" + esc(row.company_name) + "</b> (" + esc(row.profile_city) + ")<br>Partita IVA: <b>" + esc(acc.piva || "non indicata") + "</b><br>Email: " + esc(acc.email) + " · Tel: " + esc(row.phone || acc.phone || "")
      + "<br><br>Il controllo automatico (VIES) non l'ha trovata: succede spesso con le ditte che lavorano solo in Italia.<br>"
      + "1. Controllala gratis qui: <a href=\"https://telematici.agenziaentrate.gov.it/VerificaPIVA/Scegli.do?parameter=verificaPiva\">Verifica partita IVA – Agenzia delle Entrate</a><br>"
      + "2. Se risulta <b>attiva</b> e il nome corrisponde, tocca il pulsante qui sotto.";
    try { await sendEmail(adminEmail(), "Verifica P.IVA: " + (row.company_name || ""), emailLayout("Nuovo artigiano da verificare", txt, "✔ P.IVA attiva: dai il bollino", link)); } catch (e) { console.error("pro-profile email", e); }
  }
  return row;
}
function median(a) { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
// Media stelle (dai clienti che hanno accettato un preventivo) e tempi di risposta
async function statsFor(ids) {
  const out = {}; ids.forEach(id => { out[id] = { votes: [], ore: [] }; });
  if (!ids.length) return out;
  const r = await supabaseRequest("/pro_leads?artisan_id=in.(" + ids.join(",") + ")&select=artisan_id,status,v:data->voto,ore:data->rispostaOre&order=created_at.desc&limit=3000", { method: "GET" });
  (r.ok && Array.isArray(r.data) ? r.data : []).forEach(x => {
    const o = out[x.artisan_id]; if (!o) return;
    const s = x.v && +x.v.s; if (x.status === "accettata" && s >= 1 && s <= 5) o.votes.push(s);
    const h = +x.ore; if (x.ore != null && isFinite(h) && h >= 0) o.ore.push(h);
  });
  return out;
}

function publicProfile(row, withPrivate) {
  const p = {
    id: row.id,
    companyName: row.company_name || "",
    logoUrl: row.logo_url || null,
    bio: row.profile_bio || "",
    city: row.profile_city || "",
    website: row.profile_website || "",
    country: row.profile_country || "IT",
    regions: row.profile_regions || [],
    provinces: row.profile_provinces || [],
    lavorazioni: row.profile_lavorazioni || [],
    gallery: row.profile_gallery || [],
    google: row.profile_google || "",
    pivaOk: row.piva_ok === true,
    since: row.created_at || null,
    visible: !!row.profile_public,
    tier: row.tier,
  };
  if (withPrivate) { p.phone = row.phone || ""; p.email = row.email; p.accountType = row.account_type; p.declared = !!row.declared_at; p.pivaChecked = !!row.piva_checked_at; }
  return p;
}

module.exports = async function handler(req, res) {
  if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio non configurato." });
  const action = (req.query && req.query.action) || "";
  try {
    if (action === "verify") {
      const id = String(req.query.id || "").toLowerCase(), t = String(req.query.t || "");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const page = (msg) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rendrum</title><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F7F5F1;color:#1D1B18;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px"><div><div style="font-size:44px">' + msg[0] + '</div><h2>' + msg[1] + '</h2><p style="color:#6F685F">' + msg[2] + '</p></div></body>';
      const a = Buffer.from(t), b = Buffer.from(verifyToken(id));
      if (!/^[0-9a-f-]{36}$/.test(id) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send(page(["⚠️", "Link non valido", "Usa il pulsante dell'email."]));
      const u = await patchAccount(id, { piva_ok: true, piva_checked_at: new Date().toISOString() });
      const row = u.ok && Array.isArray(u.data) && u.data[0];
      if (!row || row.piva_ok !== true) return res.status(502).send(page(["⚠️", "Non riuscito", "Hai eseguito il file supabase_voti.sql su Supabase?"]));
      return res.status(200).send(page(["✔", "Fatto", "<b>" + esc(row.company_name) + "</b> ora ha il bollino “P.IVA verificata”."]));
    }

    if (action === "list") {
      if (req.method !== "GET") return res.status(405).json({ error: "Usa GET" });
      const country = String(req.query.country || "IT").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      const prov = String(req.query.province || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
      const lav = String(req.query.lav || "").replace(/[^a-z_]/g, "");
      if (!GEO[country] || !provinceIndex(country)[prov] || !LAVORAZIONI.includes(lav)) return res.status(400).json({ error: "Indica provincia e lavorazione." });
      let q = "&profile_public=eq.true&profile_country=eq." + country
        + "&profile_provinces=cs." + encodeURIComponent("{" + prov + "}")
        + "&profile_lavorazioni=cs." + encodeURIComponent("{" + lav + "}");
      if (paymentsEnabled()) q += "&subscription_status=in.(active,trialing)";
      let r = await supabaseRequest("/pro_accounts?select=" + BASE_COLS + NEW_COLS + q, { method: "GET" });
      if (!r.ok && missingColumn(r)) r = await supabaseRequest("/pro_accounts?select=" + BASE_COLS + q, { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "Ricerca non riuscita. Riprova." });
      const rows = Array.isArray(r.data) ? r.data : [];
      const st = await statsFor(rows.map(x => x.id)).catch(() => ({}));
      const now = Date.now();
      const list = rows.map(x => {
        const p = publicProfile(x, false), s = st[x.id] || { votes: [], ore: [] };
        const n = s.votes.length, avg = n ? Math.round(s.votes.reduce((a, v) => a + v, 0) / n * 10) / 10 : 0;
        p.rating = n >= 3 ? { avg, count: n } : { count: n };   // la media si mostra da 3 voti in su
        const med = s.ore.length >= 2 ? median(s.ore) : null;
        p.fast = med != null && med <= 24;
        p.risponde = med == null ? "" : med <= 24 ? "in giornata" : med <= 48 ? "entro 2 giorni" : "";
        p.nuovo = !!(x.created_at && now - Date.parse(x.created_at) < 90 * DAY);
        return p;
      }).sort((a, b) => ((TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0))
        || ((b.rating.avg || 0) - (a.rating.avg || 0))
        || ((b.pivaOk ? 1 : 0) - (a.pivaOk ? 1 : 0))
        || ((b.fast ? 1 : 0) - (a.fast ? 1 : 0)));
      list.forEach(p => { delete p.tier; delete p.visible; });
      return res.status(200).json({ artisans: list });
    }

    const acc = await currentAccount(req).catch(() => null);
    if (!acc) return res.status(401).json({ error: "Accedi al tuo account." });
    if (acc.account_type === "privato") return res.status(403).json({ error: "Il profilo artigiano è riservato ai professionisti." });

    if (action === "me") return res.status(200).json({ profile: publicProfile(acc, true) });

    if (action === "save") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const b = req.body || {};
      const companyName = clean(b.companyName, 120);
      const bio = clean(b.bio, 1500);
      const city = clean(b.city, 80);
      const phone = clean(b.phone, 30);
      const website = clean(b.website, 200);
      const google = clean(b.google, 300);
      const country = String(b.country || "IT").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2) || "IT";
      if (!GEO[country]) return res.status(400).json({ error: "Paese non ancora disponibile." });
      // Le province devono esistere; le regioni si ricavano dalle province (niente dati incoerenti).
      const pIdx = provinceIndex(country);
      const provinces = Array.from(new Set(codeList(b.provinces, /^[A-Z]{2,3}$/, 200).filter(p => pIdx[p])));
      const regions = Array.from(new Set(provinces.map(p => pIdx[p])));
      const lavorazioni = Array.from(new Set((Array.isArray(b.lavorazioni) ? b.lavorazioni : []).filter(x => LAVORAZIONI.includes(x))));
      // Si accettano solo foto già caricate da questo account nel nostro archivio.
      const ownPrefix = getSupabaseConfig().url + "/storage/v1/object/public/project-photos/profiles/" + acc.id + "/";
      let gallery = Array.from(new Set((Array.isArray(b.gallery) ? b.gallery : []).filter(u => typeof u === "string" && u.startsWith(ownPrefix)))).slice(0, 8);
      const newPhotos = (Array.isArray(b.newPhotos) ? b.newPhotos : []).filter(x => typeof x === "string" && x.startsWith("data:image/")).slice(0, 8 - gallery.length);

      const errs = [];
      // Iscrizione in un minuto: logo, descrizione e foto sono facoltativi (si aggiungono quando si vuole)
      if (companyName.length < 2) errs.push("nome dell'attività");
      if (city.length < 2) errs.push("sede (comune)");
      if (phone.replace(/\D/g, "").length < 8) errs.push("telefono");
      if (!provinces.length) errs.push("province in cui lavori");
      if (!lavorazioni.length) errs.push("lavorazioni che fai");
      if (!acc.declared_at && b.declared !== true) errs.push("la dichiarazione di responsabilità");
      if (website && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(website)) errs.push("sito web valido (https://…)");
      if (google && !GOOGLE_RE.test(google)) errs.push("link Google valido (copialo da Google Maps → Condividi)");
      // Prima si controlla tutto, poi si caricano le foto: niente file orfani.
      if (errs.length) return res.status(400).json({ error: "Completa: " + errs.join(", ") + "." });

      let failed = 0;
      for (const ph of newPhotos) {
        if (gallery.length >= 8) break;
        const url = await uploadPhoto(ph, "profiles/" + acc.id);
        if (url) gallery.push(url); else failed++;
      }
      let logoUrl = acc.logo_url || null;
      if (typeof b.newLogo === "string" && b.newLogo.startsWith("data:image/")) {
        const u = await uploadPhoto(b.newLogo, "logos/" + acc.id); if (u) logoUrl = u; else failed++;
      }
      if (failed) return res.status(400).json({ error: "Alcune foto non sono valide (usa JPG, PNG o WebP). Riprova.", gallery, logoUrl });

      const fields = {
        company_name: companyName, phone, logo_url: logoUrl,
        profile_bio: bio, profile_city: city, profile_website: website || null,
        profile_country: country, profile_regions: regions, profile_provinces: provinces,
        profile_lavorazioni: lavorazioni, profile_gallery: gallery,
        profile_public: b.visible !== false,
        profile_google: google || null,
      };
      if (!acc.declared_at) fields.declared_at = new Date().toISOString();
      const u = await patchAccount(acc.id, fields);
      if (!u.ok) { console.error("pro-profile save", u.data); return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." }); }
      let row = Array.isArray(u.data) && u.data[0] ? u.data[0] : Object.assign({}, acc, fields);
      if (row.profile_public) row = await pivaCheckOnce(acc, row, req).catch(e => { console.error("piva", e); return row; });
      return res.status(200).json({ ok: true, profile: publicProfile(row, true) });
    }
    return res.status(404).json({ error: "Azione sconosciuta" });
  } catch (err) {
    console.error("pro-profile", err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
