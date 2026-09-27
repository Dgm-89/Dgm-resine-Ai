// api/quotes.js
// Generatore di preventivi per i professionisti.
//   GET  /api/quotes?action=list               -> elenco preventivi (sintesi)
//   GET  /api/quotes?action=get&id=...         -> preventivo completo
//   POST /api/quotes?action=save               -> crea (senza id) o aggiorna (con id)
//   POST /api/quotes?action=delete             -> { id }
//   GET  /api/quotes?action=settings           -> impostazioni preventivi (dati impresa, banca, condizioni, listino)
//   POST /api/quotes?action=settings           -> salva impostazioni
// Tabelle: vedi supabase_preventivi.sql
const { currentAccount, supabaseRequest, getSupabaseConfig } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");
const { vatCheck } = require("./_vat");

const STATUSES = ["bozza", "inviato", "accettato", "rifiutato"];
const UNITS = ["a corpo", "mq", "ml", "mc", "pz", "h", "gg", "kg", "l", "forfait"];
const IVA_RATES = [22, 10, 4, 0];

// ---------- pulizia dati ----------
function str(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max); }
function num(v, min, max, dec) {
  let n;
  if (typeof v === "number") n = v;
  else { const t = String(v == null ? "" : v).trim(); n = parseFloat(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t); }
  if (!isFinite(n)) n = 0;
  n = Math.min(max, Math.max(min, n));
  const k = Math.pow(10, dec); return Math.round(n * k) / k;
}
function arr(v, max) { return (Array.isArray(v) ? v : []).slice(0, max); }
function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); if (!isNaN(d) && d.getUTCDate() === +m[3]) return m[0]; }
  return new Date().toISOString().slice(0, 10);
}
function ibanOk(iban) {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  if (s.startsWith("IT") && s.length !== 27) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let mod = 0; for (const ch of r) mod = (mod * 10 + +ch) % 97;
  return mod === 1;
}
function cleanVoce(v) {
  v = v || {};
  return {
    titolo: str(v.titolo, 160),
    descrizione: str(v.descrizione, 3000),
    qta: num(v.qta, 0, 1e6, 2),
    um: UNITS.includes(v.um) ? v.um : "a corpo",
    prezzo: num(v.prezzo, 0, 1e8, 2),
  };
}
function cleanRate(list) {
  return arr(list, 6).map(r => ({ descrizione: str(r && r.descrizione, 60), scadenza: str(r && r.scadenza, 120), pct: num(r && r.pct, 0, 100, 2) }))
    .filter(r => r.descrizione || r.pct);
}
function cleanCondizioni(list) {
  return arr(list, 25).map(c => ({ key: str(c && c.key, 20).replace(/[^a-z_]/g, ""), titolo: str(c && c.titolo, 80), testo: str(c && c.testo, 1500), approva: !!(c && c.approva) }))
    .filter(c => c.titolo && c.testo);
}

// Totali calcolati sempre qui (mai fidarsi del browser).
function totals(q) {
  const round = x => Math.round(x * 100) / 100;
  const imponibileLordo = round(q.voci.reduce((s, v) => s + round(v.qta * v.prezzo), 0));
  const sconto = round(imponibileLordo * q.scontoPct / 100);
  const imponibile = round(imponibileLordo - sconto);
  const iva = round(imponibile * q.iva.aliquota / 100);
  return { imponibileLordo, sconto, imponibile, iva, totale: round(imponibile + iva) };
}

function cleanQuote(b, acc) {
  const { url } = getSupabaseConfig();
  const own = [url + "/storage/v1/object/public/project-photos/" + acc.id + "/", url + "/storage/v1/object/public/project-photos/quotes/" + acc.id + "/"];
  const okUrl = u => typeof u === "string" && own.some(p => u.startsWith(p)) ? u : null;
  const c = b.cliente || {}, k = b.cantiere || {}, a = b.anteprima || {}, pg = b.pagamento || {}, iv = b.iva || {};
  const q = {
    data: isoDate(b.data),
    status: STATUSES.includes(b.status) ? b.status : "bozza",
    cliente: { nome: str(c.nome, 120), indirizzo: str(c.indirizzo, 200), telefono: str(c.telefono, 40), email: str(c.email, 120), cfPiva: str(c.cfPiva, 30) },
    cantiere: { indirizzo: str(k.indirizzo, 200), descrizione: str(k.descrizione, 200) },
    oggetto: str(b.oggetto, 200),
    intro: str(b.intro, 800),
    lavorazione: str(b.lavorazione, 40),
    voci: arr(b.voci, 60).map(cleanVoce).filter(v => v.titolo || v.descrizione || v.prezzo),
    scontoPct: num(b.scontoPct, 0, 100, 2),
    iva: { aliquota: IVA_RATES.includes(Number(iv.aliquota)) ? Number(iv.aliquota) : 22, nota: str(iv.nota, 200) },
    specifiche: str(b.specifiche, 2000),
    rate: cleanRate(b.rate),
    pagamento: { metodo: ["bonifico", "altro"].includes(pg.metodo) ? pg.metodo : "bonifico", testo: str(pg.testo, 400), nota: str(pg.nota, 400) },
    condizioni: cleanCondizioni(b.condizioni),
    validitaGiorni: num(b.validitaGiorni, 1, 365, 0) || 30,
    anteprima: { attiva: !!a.attiva, prima: okUrl(a.prima), dopo: okUrl(a.dopo), righe: arr(a.righe, 30).map(r => str(r, 300)).filter(Boolean) },
  };
  return q;
}
function validate(q) {
  const errs = [];
  if (q.cliente.nome.length < 2) errs.push("nome del cliente");
  if (q.oggetto.length < 3) errs.push("oggetto");
  if (!q.voci.length) errs.push("almeno una voce");
  q.voci.forEach((v, i) => { if (!v.titolo) errs.push("titolo della voce " + (i + 1)); if (!v.qta) errs.push("quantità della voce " + (i + 1)); });
  if (!q.rate.length) errs.push("condizioni di pagamento");
  else if (Math.abs(q.rate.reduce((s, r) => s + r.pct, 0) - 100) > 0.01) errs.push("rate di pagamento (la somma deve fare 100%)");
  if (q.iva.aliquota === 0 && !q.iva.nota) errs.push("motivo dell'IVA a 0% (es. reverse charge, esente art. ...)");
  return errs;
}

function summary(row) {
  const d = row.data || {};
  return { id: row.id, number: row.number, year: row.year, status: row.status, clientName: row.client_name, oggetto: d.oggetto || "", total: (row.total_cents || 0) / 100, date: d.data || null, updatedAt: row.updated_at };
}
function full(row) { return Object.assign(summary(row), { quote: row.data || {} }); }

// ---------- impostazioni ----------
function cleanSettings(b) {
  const i = b.impresa || {}, bk = b.banca || {};
  const iban = str(bk.iban, 40).replace(/\s+/g, "").toUpperCase();
  return {
    impresa: {
      ragioneSociale: str(i.ragioneSociale, 120), indirizzo: str(i.indirizzo, 200), paese: str(i.paese, 2).toUpperCase() || "IT", piva: str(i.piva, 30), cf: str(i.cf, 20),
      telefono: str(i.telefono, 40), email: str(i.email, 120), sito: str(i.sito, 120), rea: str(i.rea, 60),
    },
    banca: { intestatario: str(bk.intestatario, 120), banca: str(bk.banca, 120), iban },
    condizioni: cleanCondizioni(b.condizioni),
    rate: cleanRate(b.rate),
    specifiche: str(b.specifiche, 2000),
    validitaGiorni: num(b.validitaGiorni, 1, 365, 0) || 30,
    numeroPartenza: num(b.numeroPartenza, 0, 999999, 0),
    listino: arr(b.listino, 200).map(cleanVoce).filter(v => v.titolo),
  };
}

module.exports = async function handler(req, res) {
  if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio non configurato." });
  const action = (req.query && req.query.action) || "";
  try {
    const acc = await currentAccount(req).catch(() => null);
    if (!acc) return res.status(401).json({ error: "Accedi al tuo account." });
    if (acc.account_type === "privato") return res.status(403).json({ error: "Il generatore di preventivi è riservato ai professionisti." });
    const mine = "account_id=eq." + encodeURIComponent(acc.id);

    if (action === "settings") {
      if (req.method === "GET") return res.status(200).json({ settings: acc.quote_settings || {}, account: { companyName: acc.company_name || "", piva: acc.piva || "", phone: acc.phone || "", email: acc.email || "", logoUrl: acc.logo_url || null } });
      if (req.method !== "POST") return res.status(405).json({ error: "Metodo non valido" });
      const s = cleanSettings(req.body || {});
      // Partita IVA obbligatoria e valida (italiana o estera) per usare i preventivi.
      const v = vatCheck(s.impresa.paese, s.impresa.piva);
      if (!v.ok) return res.status(400).json({ error: v.error, code: "piva_invalid" });
      s.impresa.paese = v.country; s.impresa.piva = v.display;
      if (s.impresa.ragioneSociale.length < 2 || s.impresa.indirizzo.length < 5) return res.status(400).json({ error: "Completa ragione sociale e indirizzo della sede." });
      if (s.banca.iban && !ibanOk(s.banca.iban)) return res.status(400).json({ error: "L'IBAN non è corretto: controlla le cifre." });
      const u = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(acc.id), { method: "PATCH", body: JSON.stringify({ quote_settings: s }) });
      if (!u.ok) { console.error("quotes settings", u.data); return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." }); }
      return res.status(200).json({ ok: true, settings: s });
    }

    if (action === "list") {
      const r = await supabaseRequest("/pro_quotes?" + mine + "&select=id,number,year,status,client_name,total_cents,updated_at,data->oggetto,data->data&order=year.desc,number.desc&limit=300", { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "Non riesco a caricare i preventivi." });
      const list = (r.data || []).map(x => summary(Object.assign({}, x, { data: { oggetto: x.oggetto, data: x.data } })));
      return res.status(200).json({ quotes: list });
    }

    if (action === "get") {
      const id = String(req.query.id || "").replace(/[^0-9a-f-]/gi, "");
      const r = await supabaseRequest("/pro_quotes?" + mine + "&id=eq." + id + "&select=*", { method: "GET" });
      const row = r.ok && Array.isArray(r.data) && r.data[0];
      if (!row) return res.status(404).json({ error: "Preventivo non trovato." });
      return res.status(200).json(full(row));
    }

    if (action === "delete") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const id = String((req.body || {}).id || "").replace(/[^0-9a-f-]/gi, "");
      if (!id) return res.status(400).json({ error: "Preventivo mancante." });
      const r = await supabaseRequest("/pro_quotes?" + mine + "&id=eq." + id, { method: "DELETE" });
      if (!r.ok) return res.status(502).json({ error: "Eliminazione non riuscita." });
      return res.status(200).json({ ok: true });
    }

    if (action === "save") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const imp = (acc.quote_settings || {}).impresa || {};
      if (!vatCheck(imp.paese || "IT", imp.piva).ok) return res.status(403).json({ error: "Per creare preventivi serve la partita IVA della tua impresa: inseriscila in Dati impresa.", code: "piva_required" });
      const b = req.body || {};
      const q = cleanQuote(b.quote || {}, acc);
      const errs = validate(q);
      if (errs.length) return res.status(400).json({ error: "Completa: " + errs.join(", ") + "." });
      // Foto dell'anteprima Rendrum (solo se arrivano dal configuratore, non ancora salvate)
      const np = b.newPreview || {};
      if (q.anteprima.attiva && (np.prima || np.dopo)) {
        const [p1, p2] = await Promise.all([uploadPhoto(np.prima, "quotes/" + acc.id), uploadPhoto(np.dopo, "quotes/" + acc.id)]);
        if (p1) q.anteprima.prima = p1;
        if (p2) q.anteprima.dopo = p2;
      }
      if (q.anteprima.attiva && !q.anteprima.dopo) q.anteprima.attiva = false;
      const t = totals(q);
      q.totali = t;
      const year = +q.data.slice(0, 4);
      const now = new Date().toISOString();
      const id = String(b.id || "").replace(/[^0-9a-f-]/gi, "");

      if (id) {
        const cur = await supabaseRequest("/pro_quotes?" + mine + "&id=eq." + id + "&select=id,year,number", { method: "GET" });
        const row = cur.ok && Array.isArray(cur.data) && cur.data[0];
        if (!row) return res.status(404).json({ error: "Preventivo non trovato." });
        // Il numero resta quello assegnato; l'anno è quello della numerazione originale.
        const u = await supabaseRequest("/pro_quotes?" + mine + "&id=eq." + id, {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: q.status, client_name: q.cliente.nome, total_cents: Math.round(t.totale * 100), data: q, updated_at: now }),
        });
        const saved = u.ok && Array.isArray(u.data) && u.data[0];
        if (!saved) { console.error("quotes update", u.data); return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." }); }
        return res.status(200).json(full(saved));
      }

      // Nuovo: numero progressivo per anno (riparte dal numero indicato nelle impostazioni, se più alto).
      const start = Math.max(1, Number((acc.quote_settings || {}).numeroPartenza) || 1);
      for (let attempt = 0; attempt < 4; attempt++) {
        const last = await supabaseRequest("/pro_quotes?" + mine + "&year=eq." + year + "&select=number&order=number.desc&limit=1", { method: "GET" });
        const maxN = last.ok && Array.isArray(last.data) && last.data[0] ? last.data[0].number : 0;
        const number = Math.max(maxN + 1, year === new Date().getFullYear() ? start : 1);
        const ins = await supabaseRequest("/pro_quotes", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify([{ account_id: acc.id, year, number, status: q.status, client_name: q.cliente.nome, total_cents: Math.round(t.totale * 100), data: q, updated_at: now }]),
        });
        const saved = ins.ok && Array.isArray(ins.data) && ins.data[0];
        if (saved) return res.status(200).json(full(saved));
        if (ins.status !== 409) { console.error("quotes insert", ins.data); break; }
      }
      return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." });
    }
    return res.status(404).json({ error: "Azione sconosciuta" });
  } catch (err) {
    console.error("quotes", err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
module.exports._test = { totals, cleanQuote, validate, ibanOk, num };
