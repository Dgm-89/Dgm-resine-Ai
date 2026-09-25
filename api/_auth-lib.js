// api/_auth-lib.js
// Funzioni condivise dai 4 endpoint di login/registrazione account
// (auth-register.js, auth-login.js, auth-logout.js, auth-me.js).
// Gli account possono essere di due tipi — "professionista" o "privato" —
// ma condividono la stessa tabella, lo stesso login e gli stessi 3 piani
// a pagamento (Basic/Medium/Pro): è il campo account_type a distinguerli.
//
// NOTA IMPORTANTE SU VERCEL: i file dentro "api/" diventano automaticamente
// degli indirizzi web (es. api/auth-login.js → /api/auth-login). Questo file
// inizia con "_" apposta: Vercel NON lo trasforma in un indirizzo pubblico,
// resta solo una libreria di supporto importata dagli altri file con require().
//
// COSA SERVE PER FAR FUNZIONARE IL LOGIN (da fare una volta sola)
// 1. Crea un account gratuito su https://supabase.com e crea un nuovo progetto.
// 2. Nel progetto, vai su "SQL Editor" e incolla/esegui questo comando per
//    creare la tabella che contiene TUTTI gli account (professionisti E
//    privati — sono nella stessa tabella, distinti dal campo account_type):
//
//      create table pro_accounts (
//        id uuid primary key default gen_random_uuid(),
//        email text unique not null,
//        password_hash text not null,
//        password_salt text not null,
//        account_type text not null default 'professionista'
//          check (account_type in ('professionista','privato')),
//        company_name text,
//        piva text,
//        phone text,
//        tier text not null default 'basic' check (tier in ('basic','medium','pro')),
//        logo_url text,
//        created_at timestamptz not null default now()
//      );
//
//    Nota su "company_name": per i professionisti contiene la ragione
//    sociale; per i privati contiene semplicemente nome e cognome. Il campo
//    non è più obbligatorio a livello di database (NOT NULL rimosso) perché
//    entrambi i tipi di account lo valorizzano comunque dal form, ma così il
//    database non blocca nulla se in futuro cambia la logica.
//
//    SE LA TABELLA "pro_accounts" ESISTE GIA' (creata prima che i privati
//    potessero registrarsi), esegui invece questi due comandi per aggiornarla
//    senza perdere gli account già creati:
//
//      alter table pro_accounts add column if not exists account_type text
//        not null default 'professionista'
//        check (account_type in ('professionista','privato'));
//      alter table pro_accounts alter column company_name drop not null;
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
    accountType: row.account_type || "professionista",
    companyName: row.company_name,
    piva: row.piva,
    phone: row.phone,
    tier: row.tier,
    logoUrl: row.logo_url,
    subscriptionStatus: row.subscription_status || "none",
    usageMonth: row.usage_month || null,
    usageCount: row.usage_count || 0,
    usageLimit: (PLAN_LIMITS[row.tier] || 0),
    paymentsEnabled: paymentsEnabled(),
  };
}

// Piani a pagamento (prezzi in centesimi di euro al mese, IVA esclusa) e
// anteprime AI incluse ogni mese. Valgono sia per i privati sia per i
// professionisti. Per cambiare un prezzo basta modificarlo qui.
const PLANS = {
  basic:  { name: "Rendrum Basic",  priceCents: 1900, images: 30 },
  medium: { name: "Rendrum Medium", priceCents: 4900, images: 150 },
  pro:    { name: "Rendrum Pro",    priceCents: 9900, images: 400 },
};
const PLAN_LIMITS = { basic: PLANS.basic.images, medium: PLANS.medium.images, pro: PLANS.pro.images };

// I pagamenti sono attivi solo quando su Vercel c'è STRIPE_SECRET_KEY: finché
// manca, l'app continua a funzionare come prima (anteprime libere).
function paymentsEnabled() { return Boolean((process.env.STRIPE_SECRET_KEY || "").trim()); }

// Chiamata alla REST API di Stripe (form-encoded), senza librerie esterne.
function toForm(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(function (k) {
    const v = obj[k]; if (v === undefined || v === null) return;
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (typeof v === "object") toForm(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  });
  return out;
}
async function stripeRequest(method, path, params) {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? toForm(params).join("&") : undefined,
  });
  const data = await r.json().catch(function () { return null; });
  return { ok: r.ok, status: r.status, data };
}

// Legge l'account della sessione corrente (o null).
async function currentAccount(req) {
  const { configured } = getSupabaseConfig();
  if (!configured) return null;
  const token = readSessionCookie(req);
  const session = token ? verifySession(token) : null;
  if (!session || !session.sub) return null;
  const found = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(session.sub) + "&select=*", { method: "GET" });
  return found.ok && Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
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
  PLANS,
  PLAN_LIMITS,
  paymentsEnabled,
  stripeRequest,
  currentAccount,
};
