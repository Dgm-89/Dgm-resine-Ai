// api/_auth-lib.js
// Funzioni condivise dai 4 endpoint di login/registrazione professionisti
// (auth-register.js, auth-login.js, auth-logout.js, auth-me.js).
//
// NOTA IMPORTANTE SU VERCEL: i file dentro "api/" diventano automaticamente
// degli indirizzi web (es. api/auth-login.js → /api/auth-login). Questo file
// inizia con "_" apposta: Vercel NON lo trasforma in un indirizzo pubblico,
// resta solo una libreria di supporto importata dagli altri file con require().
//
// COSA SERVE PER FAR FUNZIONARE IL LOGIN (da fare una volta sola)
// 1. Crea un account gratuito su https://supabase.com e crea un nuovo progetto.
// 2. Nel progetto, vai su "SQL Editor" e incolla/esegui questo comando per
//    creare la tabella che contiene gli account dei professionisti:
//
//      create table pro_accounts (
//        id uuid primary key default gen_random_uuid(),
//        email text unique not null,
//        password_hash text not null,
//        password_salt text not null,
//        company_name text not null,
//        piva text,
//        phone text,
//        tier text not null default 'basic' check (tier in ('basic','medium','pro')),
//        logo_url text,
//        created_at timestamptz not null default now()
//      );
//
// 3. Vai su "Project Settings" → "API": copia l'indirizzo "Project URL" e la
//    chiave segreta "service_role" (NON la "anon public", quella è diversa).
// 4. Su Vercel, in "Settings > Environment Variables" del progetto, aggiungi:
//      SUPABASE_URL = l'indirizzo copiato al punto 3
//      SUPABASE_SERVICE_KEY = la chiave "service_role" copiata al punto 3
//      JWT_SECRET = una password lunga e a caso, a scelta tua (serve solo per
//                   firmare la sessione di accesso, tienila segreta e non
//                   cambiarla più una volta scelta, altrimenti tutti gli
//                   utenti già loggati verrebbero disconnessi)
// 5. Fai il deploy. Da quel momento login e registrazione funzionano davvero.
//
// Finché questi passaggi non sono fatti, le funzioni sotto restituiscono un
// errore chiaro ("Servizio account non configurato") invece di andare in crash.

const crypto = require("crypto");

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
  const jwtSecret = (process.env.JWT_SECRET || "").trim();
  return { url, key, jwtSecret, configured: Boolean(url && key && jwtSecret) };
}

// Chiama la REST API di Supabase (PostgREST) sulla tabella pro_accounts.
async function supabaseRequest(path, options) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(url + "/rest/v1" + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(options && options.headers ? options.headers : {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

// Password: scrypt con salt casuale, confronto a tempo costante.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Sessione: un token firmato "fatto in casa" (stile JWT, senza librerie
// esterne): base64url(payload) + "." + firma HMAC-SHA256(payload, JWT_SECRET).
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString("utf8");
}
function signSession(payloadObj) {
  const { jwtSecret } = getSupabaseConfig();
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = base64url(crypto.createHmac("sha256", jwtSecret).update(payload).digest());
  return payload + "." + sig;
}
function verifySession(token) {
  try {
    const { jwtSecret } = getSupabaseConfig();
    const parts = (token || "").split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expectedSig = base64url(crypto.createHmac("sha256", jwtSecret).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(base64urlDecode(payload));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

const COOKIE_NAME = "dgm_session";
const SESSION_DAYS = 30;

function setSessionCookie(res, userId) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ sub: userId, exp });
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}
function readSessionCookie(req) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(function (p) { return p.trim(); });
  for (const p of parts) {
    if (p.indexOf(COOKIE_NAME + "=") === 0) {
      return p.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

// Toglie i campi sensibili prima di restituire l'utente al frontend.
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    companyName: row.company_name,
    piva: row.piva,
    phone: row.phone,
    tier: row.tier,
    logoUrl: row.logo_url,
  };
}

module.exports = {
  getSupabaseConfig,
  supabaseRequest,
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  verifySession,
  publicUser,
};
