// api/auth-social.js — "Continua con Google" e "Continua con Apple" (sito web).
//
//   GET  /api/auth-social?action=config          -> { google: clientId|null, apple: bool }
//   GET  /api/auth-social?provider=apple         -> porta alla pagina di Apple
//   POST /api/auth-social  (Google: credential)  -> ritorno da Google (pulsante ufficiale, modalità redirect)
//   POST /api/auth-social  (Apple: code, state)  -> ritorno da Apple (response_mode=form_post)
//   POST /api/auth-social?action=onboard         -> { accountType, companyName, piva, phone } primo accesso
//
// App iPhone/Android (il login si fa nel browser di sistema, poi si torna nell'app):
//   GET  /api/auth-social?provider=google|apple&app=1&c=<sfida>   -> pagina di Google/Apple
//   GET  /api/auth-social?code=..&state=..        -> ritorno da Google (codice OAuth)
//        ... al termine: com.rendrum.app://auth?t=<biglietto>   (oppure ?err=<messaggio>)
//   GET  /api/auth-social?action=app-login&t=..&v=<verifica>      -> dentro l'app: crea la sessione
//   La "sfida" è l'impronta SHA-256 di un codice casuale che resta solo nell'app: il biglietto
//   da solo non basta per entrare (come PKCE).
//
// Variabili su Vercel:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   APPLE_SERVICES_ID (es. com.rendrum.web), APPLE_TEAM_ID, APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_KEY_P8
// Tabella: vedi supabase_accesso_social.sql (colonne google_sub, apple_sub, ...).
//
// Regole:
//  - stessa email già registrata  -> si entra nell'account esistente (lo colleghiamo);
//  - email nuova                  -> nuovo account; al primo accesso chiediamo "privato o impresa?";
//  - gli account creati così non hanno una password: possono crearla con "Password dimenticata?".
const crypto = require("crypto");
const { supabaseRequest, getSupabaseConfig, setSessionCookie, publicUser, currentAccount, hashPassword, siteOrigin } = require("./_auth-lib");

const env = (k) => String(process.env[k] || "").trim();
const GOOGLE_ID = () => env("GOOGLE_CLIENT_ID");
const GOOGLE_SECRET = () => env("GOOGLE_CLIENT_SECRET");
const APP_SCHEME = "com.rendrum.app";
const APPLE = () => ({ sid: env("APPLE_SERVICES_ID"), team: env("APPLE_TEAM_ID"), kid: env("APPLE_SIGNIN_KEY_ID"), p8: env("APPLE_SIGNIN_KEY_P8").replace(/\\n/g, "\n") });
const appleOn = () => { const a = APPLE(); return !!(a.sid && a.team && a.kid && /BEGIN PRIVATE KEY/.test(a.p8)); };

function b64url(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlJson(s) { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return JSON.parse(Buffer.from(s, "base64").toString("utf8")); }
function jwtPayload(t) { try { return b64urlJson(String(t).split(".")[1]); } catch (e) { return null; } }
function hmac(s) { return b64url(crypto.createHmac("sha256", getSupabaseConfig().jwtSecret || "rd").update("social:" + s).digest()); }
// "state" firmato: niente cookie (Apple torna con un POST da un altro sito e i cookie non arrivano)
function makeState(provider, extra) { const p = b64url(JSON.stringify(Object.assign({ p: provider, t: Date.now(), n: crypto.randomBytes(8).toString("hex") }, extra || {}))); return p + "." + hmac(p); }
function readState(st) {
  const [p, sig] = String(st || "").split(".");
  if (!p || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = b64urlJson(p); return Date.now() - o.t < 15 * 60 * 1000 ? o : null; } catch (e) { return null; }
}
function origin(req) { return siteOrigin(req).replace(/\/+$/, ""); }
function backTo(res, url) { res.statusCode = 303; res.setHeader("Location", url); res.end(); }
function fail(req, res, msg) { return backTo(res, origin(req) + "/?accesso=errore&msg=" + encodeURIComponent(msg)); }
function missingColumn(r) { return /PGRST204|42703|column/i.test(JSON.stringify((r && r.data) || "")); }
function cleanName(s) { return String(s || "").replace(/[<>\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120); }

// ---------------- App: ritorno nell'app ----------------
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;          // SHA-256 in base64url
function appTicket(row, isNew, c) {
  const p = b64url(JSON.stringify({ a: row.id, s: Number(row.session_version) || 0, c: c, n: isNew ? 1 : 0, e: Date.now() + 3 * 60 * 1000 }));
  return p + "." + b64url(crypto.createHmac("sha256", getSupabaseConfig().jwtSecret || "rd").update("app:" + p).digest());
}
function readTicket(t) {
  const [p, sig] = String(t || "").split(".");
  if (!p || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(b64url(crypto.createHmac("sha256", getSupabaseConfig().jwtSecret || "rd").update("app:" + p).digest()));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = b64urlJson(p); return o.e > Date.now() ? o : null; } catch (e) { return null; }
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
// Pagina mostrata nel browser di sistema: riapre l'app (con pulsante di riserva).
function backToApp(res, query, ok) {
  const url = APP_SCHEME + "://auth?" + query;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end('<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rendrum</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FBF6F1;color:#2A1D14;font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px;box-sizing:border-box}' +
    'a{display:inline-block;margin-top:16px;padding:14px 26px;border-radius:999px;background:#D0844F;color:#fff;font-weight:700;text-decoration:none}</style></head><body><div>' +
    "<p>" + (ok ? "Accesso riuscito." : "Accesso non riuscito.") + "</p><a href=\"" + esc(url) + "\">Torna all'app Rendrum</a></div>" +
    "<script>location.href=" + JSON.stringify(url).replace(/</g, "\\u003c") + ";</script></body></html>");
}
function appFail(res, msg) { return backToApp(res, "err=" + encodeURIComponent(msg), false); }

// ---------------- Google: verifica del "credential" (id_token) ----------------
async function googleIdentity(credential) {
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!r.ok) return null;
  const t = await r.json().catch(() => null);
  if (!t || t.aud !== GOOGLE_ID() || !/^(https:\/\/)?accounts\.google\.com$/.test(t.iss || "") || Number(t.exp) * 1000 < Date.now()) return null;
  if (!(t.email_verified === true || t.email_verified === "true")) return null;
  return { provider: "google", sub: String(t.sub), email: String(t.email || "").toLowerCase(), name: cleanName(t.name || [t.given_name, t.family_name].filter(Boolean).join(" ")) };
}

// Google (app): codice OAuth -> id_token, scambiato direttamente con Google su HTTPS
async function googleCodeIdentity(code, redirectUri) {
  const form = new URLSearchParams({ client_id: GOOGLE_ID(), client_secret: GOOGLE_SECRET(), code: String(code), grant_type: "authorization_code", redirect_uri: redirectUri });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id_token) { console.error("google token", r.status, j && j.error); return null; }
  const t = jwtPayload(j.id_token);
  if (!t || t.aud !== GOOGLE_ID() || !/^(https:\/\/)?accounts\.google\.com$/.test(t.iss || "") || !t.sub) return null;
  if (!(t.email_verified === true || t.email_verified === "true")) return null;
  return { provider: "google", sub: String(t.sub), email: String(t.email || "").toLowerCase(), name: cleanName(t.name || [t.given_name, t.family_name].filter(Boolean).join(" ")) };
}

// ---------------- Apple ----------------
function appleClientSecret(clientId) {
  const a = APPLE(), now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "ES256", kid: a.kid, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: a.team, iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: clientId || a.sid }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: a.p8, dsaEncoding: "ieee-p1363" });
  return head + "." + body + "." + b64url(sig);
}
async function appleIdentity(code, redirectUri, userJson) {
  const a = APPLE();
  const form = new URLSearchParams({ client_id: a.sid, client_secret: appleClientSecret(a.sid), code: String(code), grant_type: "authorization_code", redirect_uri: redirectUri });
  const r = await fetch("https://appleid.apple.com/auth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id_token) { console.error("apple token", r.status, j && j.error); return null; }
  const t = jwtPayload(j.id_token);   // arriva direttamente da Apple su HTTPS: è affidabile
  if (!t || t.aud !== a.sid || t.iss !== "https://appleid.apple.com" || !t.sub) return null;
  let name = "";
  try { const u = typeof userJson === "string" ? JSON.parse(userJson) : userJson; if (u && u.name) name = cleanName([u.name.firstName, u.name.lastName].filter(Boolean).join(" ")); } catch (e) {}
  return { provider: "apple", sub: String(t.sub), email: String(t.email || "").toLowerCase(), name, refresh: j.refresh_token || null, relay: String(t.is_private_email) === "true" };
}

// ---------------- account: trova, collega o crea ----------------
async function findOrCreate(id) {
  const col = id.provider === "google" ? "google_sub" : "apple_sub";
  // 1) già collegato
  let r = await supabaseRequest("/pro_accounts?" + col + "=eq." + encodeURIComponent(id.sub) + "&select=*", { method: "GET" });
  if (!r.ok && missingColumn(r)) return { error: "Accesso con " + (id.provider === "google" ? "Google" : "Apple") + " non ancora attivo: manca il file supabase_accesso_social.sql su Supabase." };
  let row = r.ok && Array.isArray(r.data) && r.data[0];
  const extra = id.refresh ? { apple_refresh_token: id.refresh } : {};
  if (row) {
    if (id.refresh) await supabaseRequest("/pro_accounts?id=eq." + row.id, { method: "PATCH", body: JSON.stringify(extra) });
    return { row, isNew: !!row.needs_onboarding };
  }
  if (!id.email) return { error: "Il tuo account " + (id.provider === "google" ? "Google" : "Apple") + " non ci ha dato l'indirizzo email. Riprova oppure registrati con email e password." };
  // 2) stessa email già registrata: colleghiamo
  r = await supabaseRequest("/pro_accounts?email=eq." + encodeURIComponent(id.email) + "&select=*", { method: "GET" });
  row = r.ok && Array.isArray(r.data) && r.data[0];
  if (row) {
    const u = await supabaseRequest("/pro_accounts?id=eq." + row.id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(Object.assign({ [col]: id.sub, email_verified: true }, extra)) });
    row = (u.ok && u.data && u.data[0]) || row;
    return { row, isNew: !!row.needs_onboarding, linked: true };
  }
  // 3) nuovo account (senza password: la può creare con "Password dimenticata?")
  const { hash, salt } = hashPassword(crypto.randomBytes(32).toString("hex"));
  const ins = await supabaseRequest("/pro_accounts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([Object.assign({
    email: id.email, password_hash: hash, password_salt: salt, account_type: "privato", company_name: id.name || null,
    tier: "basic", email_verified: true, [col]: id.sub, password_set: false, needs_onboarding: true,
  }, extra)]) });
  if (!ins.ok || !Array.isArray(ins.data) || !ins.data[0]) { console.error("social create", ins.status, ins.data); return { error: "Non riesco a creare l'account. Riprova." }; }
  return { row: ins.data[0], isNew: true };
}
async function finish(req, res, id, st) {
  const app = st && st.app && CHALLENGE_RE.test(st.c || "");
  if (!id) return app ? appFail(res, "Accesso non riuscito. Riprova.") : fail(req, res, "Accesso non riuscito. Riprova.");
  const out = await findOrCreate(id);
  if (out.error) return app ? appFail(res, out.error) : fail(req, res, out.error);
  if (app) return backToApp(res, "t=" + encodeURIComponent(appTicket(out.row, out.isNew, st.c)), true);
  setSessionCookie(res, out.row.id, out.row.session_version);
  return backTo(res, origin(req) + "/?accesso=" + (out.isNew ? "nuovo" : "ok"));
}

module.exports = async function handler(req, res) {
  if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio non configurato." });
  const q = req.query || {}, action = q.action || "";
  try {
    if (action === "config") return res.status(200).json({ google: GOOGLE_ID() || null, apple: appleOn(), app: { google: !!(GOOGLE_ID() && GOOGLE_SECRET()), apple: appleOn() } });

    // App: il biglietto torna dentro l'app insieme al codice di verifica -> sessione nell'app
    if (action === "app-login") {
      const tk = readTicket(q.t);
      const v = String(q.v || "");
      if (!tk || !/^[A-Za-z0-9_-]{43,128}$/.test(v) || b64url(crypto.createHash("sha256").update(v).digest()) !== tk.c) return fail(req, res, "Accesso scaduto. Riprova.");
      const r = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(tk.a) + "&select=id,session_version", { method: "GET" });
      const row = r.ok && Array.isArray(r.data) && r.data[0];
      if (!row || (Number(row.session_version) || 0) !== (Number(tk.s) || 0)) return fail(req, res, "Accesso scaduto. Riprova.");
      setSessionCookie(res, row.id, row.session_version);
      return backTo(res, origin(req) + "/?accesso=" + (tk.n ? "nuovo" : "ok"));
    }

    // App: partenza verso Google o Apple (nel browser di sistema)
    if (req.method === "GET" && q.app === "1" && (q.provider === "google" || q.provider === "apple")) {
      const c = String(q.c || "");
      if (!CHALLENGE_RE.test(c)) return appFail(res, "Richiesta non valida. Aggiorna l'app e riprova.");
      if (q.provider === "google") {
        if (!GOOGLE_ID() || !GOOGLE_SECRET()) return appFail(res, "Accesso con Google non ancora attivo.");
        return backTo(res, "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: GOOGLE_ID(), redirect_uri: origin(req) + "/api/auth-social",
          response_type: "code", scope: "openid email profile", prompt: "select_account", state: makeState("google", { app: 1, c: c }) }).toString());
      }
      if (!appleOn()) return appFail(res, "Accesso con Apple non ancora attivo.");
      return backTo(res, "https://appleid.apple.com/auth/authorize?" + new URLSearchParams({ response_type: "code", response_mode: "form_post", client_id: APPLE().sid,
        redirect_uri: origin(req) + "/api/auth-social", scope: "name email", state: makeState("apple", { app: 1, c: c }) }).toString());
    }

    // App: ritorno da Google (GET con codice)
    if (req.method === "GET" && q.state && (q.code || q.error)) {
      const st = readState(q.state);
      if (!st || st.p !== "google" || !st.app) return fail(req, res, "Accesso scaduto. Riprova.");
      if (q.error) return appFail(res, "Accesso annullato.");
      return await finish(req, res, await googleCodeIdentity(q.code, origin(req) + "/api/auth-social"), st);
    }

    if (action === "onboard") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const acc = await currentAccount(req);
      if (!acc) return res.status(401).json({ error: "Accedi di nuovo." });
      if (acc.needs_onboarding !== true) return res.status(200).json({ ok: true, user: publicUser(acc) });
      const b = req.body || {};
      const type = b.accountType === "professionista" ? "professionista" : "privato";
      const name = cleanName(b.companyName);
      const phone = String(b.phone || "").replace(/[^\d+ ]/g, "").trim().slice(0, 30);
      const piva = type === "professionista" ? String(b.piva || "").replace(/\s/g, "").slice(0, 20) : "";
      if (name.length < 2) return res.status(400).json({ error: type === "privato" ? "Scrivi nome e cognome." : "Scrivi il nome della tua impresa." });
      if (type === "professionista" && phone.replace(/\D/g, "").length < 8) return res.status(400).json({ error: "Scrivi il telefono dell'impresa." });
      const u = await supabaseRequest("/pro_accounts?id=eq." + acc.id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ account_type: type, company_name: name, piva: piva || null, phone: phone || acc.phone || null, needs_onboarding: false }) });
      if (!u.ok || !u.data || !u.data[0]) return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." });
      return res.status(200).json({ ok: true, user: publicUser(u.data[0]) });
    }

    // Apple: partenza
    if (req.method === "GET" && q.provider === "apple") {
      if (!appleOn()) return fail(req, res, "Accesso con Apple non ancora attivo.");
      const url = "https://appleid.apple.com/auth/authorize?" + new URLSearchParams({ response_type: "code", response_mode: "form_post", client_id: APPLE().sid,
        redirect_uri: origin(req) + "/api/auth-social", scope: "name email", state: makeState("apple") }).toString();
      return backTo(res, url);
    }

    if (req.method === "POST") {
      const b = req.body || {};
      // Google (pulsante ufficiale, modalità redirect)
      if (b.credential) {
        if (!GOOGLE_ID()) return fail(req, res, "Accesso con Google non ancora attivo.");
        const ck = String(req.headers.cookie || "").match(/(?:^|;\s*)g_csrf_token=([^;]+)/);
        if (ck && b.g_csrf_token && ck[1] !== b.g_csrf_token) return fail(req, res, "Accesso non valido. Riprova.");
        return await finish(req, res, await googleIdentity(b.credential));
      }
      // Apple (ritorno con form_post)
      if (b.code || b.error) {
        const st = readState(b.state);
        if (b.error) return st && st.app ? appFail(res, "Accesso annullato.") : backTo(res, origin(req) + "/");   // l'utente ha annullato
        if (!st || st.p !== "apple") return fail(req, res, "Accesso scaduto. Riprova.");
        return await finish(req, res, await appleIdentity(b.code, origin(req) + "/api/auth-social", b.user), st);
      }
    }
    return res.status(400).json({ error: "Richiesta non valida." });
  } catch (err) {
    console.error("auth-social", err);
    return fail(req, res, "Errore imprevisto. Riprova.");
  }
};
module.exports._test = { makeState, readState, appleClientSecret, jwtPayload, appTicket, readTicket };
