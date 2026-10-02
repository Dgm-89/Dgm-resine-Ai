// api/_jobs.js — lavori di generazione salvati (tabella rendrum_jobs, vedi supabase_lavori.sql).
//
// Ogni anteprima diventa un "lavoro": la foto di partenza, le bozze e il risultato
// vengono salvati mentre l'AI lavora. Così:
//  - se il cliente chiude l'app o blocca il telefono, il risultato non si perde;
//  - quando riapre Rendrum (anche da un altro dispositivo) lo ritrova;
//  - se ha toccato "Chiudi, avvisami", gli arriva un'email quando è pronto.
// Se la tabella non esiste ancora, tutto funziona come prima (senza salvataggio).
const { supabaseRequest, currentAccount, sendEmail, emailEnabled, siteOrigin } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RUN_MS = 8 * 60 * 1000;   // oltre questo tempo un lavoro "in corso" è considerato fallito
function validId(id) { return UUID.test(String(id || "")); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function cleanTitle(t) { return String(t || "").replace(/[<>\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120); }

async function patch(id, fields) {
  return supabaseRequest("/rendrum_jobs?id=eq." + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, fields)) }).catch(() => ({ ok: false }));
}
async function getRow(id, accId) {
  const r = await supabaseRequest("/rendrum_jobs?id=eq." + encodeURIComponent(id) + "&account_id=eq." + encodeURIComponent(accId) + "&select=*", { method: "GET" }).catch(() => ({ ok: false }));
  if (!r.ok) return { missing: true };
  return { row: Array.isArray(r.data) ? r.data[0] : null };
}

// Avvio del lavoro (dopo il controllo di abbonamento e anteprime). Ritorna null se non si può salvare.
async function start(req, acc, id, meta, b64, mime) {
  if (!acc || !validId(id)) return null;
  let m = meta && typeof meta === "object" ? meta : {};
  let s = JSON.stringify(m);
  if (s.length > 120000) { m = Object.assign({}, m); delete m.snap; s = JSON.stringify(m); }
  if (s.length > 120000) m = {};
  const ins = await supabaseRequest("/rendrum_jobs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ id, account_id: acc.id, status: "running", title: cleanTitle(m.title), meta: m }]) }).catch(() => ({ ok: false }));
  if (!ins.ok) return null;
  const job = { id, acc, req, closed: false, partials: [] };
  // la foto di partenza si salva mentre l'AI lavora (non rallenta la generazione)
  job.inputP = uploadPhoto("data:" + (mime || "image/jpeg") + ";base64," + b64, "lavori/" + acc.id)
    .then((url) => (url ? patch(id, { input_url: url }) : null)).catch(() => null);
  return job;
}

// Bozza intermedia: rimpicciolita (pesa poco) e salvata, il sito la mostra mentre aspetta.
async function partial(job, b64) {
  if (!job || job.closed) return;
  const p = (async () => {
    let out = b64, mime = "image/png";
    try {
      const sharp = require("sharp");
      out = (await sharp(Buffer.from(b64, "base64")).resize({ width: 900, height: 900, fit: "inside" }).jpeg({ quality: 70 }).toBuffer()).toString("base64");
      mime = "image/jpeg";
    } catch (e) { if (b64.length > 6000000) return; }
    const url = await uploadPhoto("data:" + mime + ";base64," + out, "lavori/" + job.acc.id);
    if (url && !job.closed) await patch(job.id, { partial_url: url });
  })().catch(() => {});
  job.partials.push(p);
  return p;
}

async function done(job, b64, mime) {
  if (!job || job.closed) return;
  job.closed = true;
  const [url] = await Promise.all([
    uploadPhoto("data:" + (mime || "image/jpeg") + ";base64," + b64, "lavori/" + job.acc.id).catch(() => null),
    job.inputP, Promise.all(job.partials),
  ]);
  if (!url) { await patch(job.id, { status: "error", error: "Salvataggio del risultato non riuscito." }); return; }
  await patch(job.id, { status: "done", result_url: url });
  await noticeIfWanted(job.req, job.id, job.acc);
}

async function fail(job, msg) {
  if (!job || job.closed) return;
  job.closed = true;
  await Promise.all([job.inputP, Promise.all(job.partials)]).catch(() => {});
  await patch(job.id, { status: "error", error: String(msg || "Generazione non riuscita").slice(0, 300) });
  await noticeIfWanted(job.req, job.id, job.acc);
}

// Email "è pronta" (una sola volta, solo se il cliente l'ha chiesta).
async function noticeIfWanted(req, id, acc) {
  if (!emailEnabled() || !acc || !acc.email) return false;
  const r = await supabaseRequest("/rendrum_jobs?id=eq." + encodeURIComponent(id) + "&notify=eq.true&notified_at=is.null&status=neq.running",
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ notified_at: new Date().toISOString() }) }).catch(() => ({ ok: false }));
  const row = r.ok && Array.isArray(r.data) && r.data[0];
  if (!row) return false;
  const link = siteOrigin(req) + "/?lavoro=" + id;
  const ok = row.status === "done";
  const html = '<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#2B241C">'
    + '<h2 style="margin:0 0 10px;font-family:Georgia,serif">' + (ok ? "La tua anteprima è pronta" : "Non siamo riusciti a creare l'anteprima") + '</h2>'
    + '<p style="font-size:15px;line-height:1.5;margin:0 0 16px">' + (ok
      ? "Ecco il risultato" + (row.title ? " di <b>" + esc(row.title) + "</b>" : "") + ". Aprilo per confrontare prima e dopo e chiedere il preventivo."
      : "Qualcosa non è andato a buon fine" + (row.title ? " con <b>" + esc(row.title) + "</b>" : "") + ". L'anteprima non ti è stata scalata: puoi riprovare quando vuoi.") + '</p>'
    + (ok && row.result_url ? '<a href="' + link + '"><img src="' + esc(row.result_url) + '" alt="" style="width:100%;border-radius:12px;display:block;margin:0 0 18px"></a>' : "")
    + '<p style="margin:0 0 22px"><a href="' + (ok ? link : siteOrigin(req)) + '" style="background:#D0844F;color:#fff;text-decoration:none;font-weight:bold;padding:13px 24px;border-radius:999px;display:inline-block">' + (ok ? "Vedi il risultato" : "Riprova su Rendrum") + '</a></p>'
    + '<p style="font-size:12px;color:#8A7F72">Rendrum S.r.l.s. · info@rendrum.com</p></div>';
  return sendEmail(acc.email, ok ? "La tua anteprima Rendrum è pronta" : "La tua anteprima Rendrum non è riuscita", html).catch(() => false);
}

function publicJob(row, full) {
  let status = row.status;
  if (status === "running" && Date.now() - new Date(row.created_at).getTime() > MAX_RUN_MS) status = "error";
  const out = { id: row.id, status, title: row.title || "", partialUrl: row.partial_url || null, resultUrl: status === "done" ? row.result_url : null,
    error: status === "error" ? (row.error || "La generazione non è riuscita: l'anteprima non ti è stata scalata.") : null, notify: !!row.notify, createdAt: row.created_at };
  if (full) { out.inputUrl = row.input_url || null; out.meta = row.meta || {}; }
  return out;
}

// GET /api/generate-preview?job=ID[&full=1]  -> stato del lavoro (solo il proprietario)
async function handleGet(req, res) {
  const acc = await currentAccount(req).catch(() => null);
  if (!acc) return res.status(401).json({ error: "Accedi per vedere la tua anteprima.", code: "login_required" });
  const q = req.query || {};
  if (!validId(q.job)) return res.status(400).json({ error: "Lavoro non valido." });
  const g = await getRow(q.job, acc.id);
  if (g.missing) return res.status(404).json({ error: "Salvataggio dei lavori non attivo.", code: "nojobs" });
  if (!g.row) return res.status(404).json({ error: "Anteprima non trovata.", code: "nojob" });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ job: publicJob(g.row, q.full === "1") });
}

// POST /api/generate-preview?action=notify  { job }  -> "Chiudi, avvisami quando è pronta"
async function handleNotify(req, res) {
  const acc = await currentAccount(req).catch(() => null);
  if (!acc) return res.status(401).json({ error: "Accedi di nuovo.", code: "login_required" });
  const id = (req.body && req.body.job) || (req.query && req.query.job);
  if (!validId(id)) return res.status(400).json({ error: "Lavoro non valido." });
  const u = await supabaseRequest("/rendrum_jobs?id=eq." + encodeURIComponent(id) + "&account_id=eq." + encodeURIComponent(acc.id),
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ notify: true, updated_at: new Date().toISOString() }) }).catch(() => ({ ok: false }));
  if (!u.ok) return res.status(404).json({ error: "Salvataggio dei lavori non attivo.", code: "nojobs" });
  const row = Array.isArray(u.data) && u.data[0];
  if (!row) return res.status(404).json({ error: "Anteprima non trovata.", code: "nojob" });
  if (row.status !== "running") await noticeIfWanted(req, id, acc);
  return res.status(200).json({ ok: true, email: emailEnabled() ? acc.email : null, status: row.status });
}

module.exports = { validId, start, partial, done, fail, handleGet, handleNotify, publicJob };
