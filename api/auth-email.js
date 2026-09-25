// api/auth-email.js
// Conferma email e recupero password, in un unico file (una sola funzione su Vercel):
//   GET  /api/auth-email?action=verify&token=...   → conferma l'email e fa entrare
//   POST /api/auth-email?action=resend   {email}   → rimanda l'email di conferma
//   POST /api/auth-email?action=forgot   {email}   → manda il link per una nuova password
//   POST /api/auth-email?action=reset    {token, password} → imposta la nuova password
const {
  getSupabaseConfig, supabaseRequest, setSessionCookie, publicUser, hashPassword,
  emailEnabled, sendEmail, emailLayout, siteOrigin, newToken, sendVerifyEmail,
} = require("./_auth-lib");

async function findBy(field, value) {
  const r = await supabaseRequest("/pro_accounts?" + field + "=eq." + encodeURIComponent(value) + "&select=*", { method: "GET" });
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}
async function update(id, fields) {
  return supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(fields) });
}

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";
  if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio account non configurato." });
  const body = req.body || {};
  try {
    if (action === "verify") {
      const token = String((req.query && req.query.token) || "");
      const acc = token.length > 20 ? await findBy("verify_token", token) : null;
      if (!acc) { res.statusCode = 302; res.setHeader("Location", "/?verificato=scaduto"); return res.end(); }
      await update(acc.id, { email_verified: true, verify_token: null });
      setSessionCookie(res, acc.id);
      res.statusCode = 302; res.setHeader("Location", "/?verificato=1"); return res.end();
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
    const email = String(body.email || "").trim().toLowerCase();

    if (action === "resend") {
      if (!emailEnabled()) return res.status(200).json({ ok: true });
      const acc = email ? await findBy("email", email) : null;
      if (acc && acc.email_verified === false) {
        const token = newToken();
        await update(acc.id, { verify_token: token });
        await sendVerifyEmail(req, email, token);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "forgot") {
      if (!emailEnabled()) return res.status(503).json({ error: "Invio email non ancora attivo: contatta info@rendrum.com." });
      const acc = email ? await findBy("email", email) : null;
      if (acc) {
        const token = newToken();
        await update(acc.id, { reset_token: token, reset_expires: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
        const url = siteOrigin(req) + "/?reset=" + token;
        await sendEmail(email, "Nuova password Rendrum",
          emailLayout("Reimposta la password", "Hai chiesto di cambiare la password del tuo account Rendrum. Il link vale 1 ora. Se non sei stato tu, ignora questa email.", "Scegli la nuova password", url));
      }
      // Risposta uguale in ogni caso: non riveliamo quali email sono registrate.
      return res.status(200).json({ ok: true });
    }

    if (action === "reset") {
      const token = String(body.token || ""), password = String(body.password || "");
      if (password.length < 6) return res.status(400).json({ error: "La password deve avere almeno 6 caratteri." });
      const acc = token.length > 20 ? await findBy("reset_token", token) : null;
      if (!acc || !acc.reset_expires || new Date(acc.reset_expires).getTime() < Date.now()) {
        return res.status(400).json({ error: "Link scaduto o non valido: richiedi di nuovo \"Password dimenticata\"." });
      }
      const { hash, salt } = hashPassword(password);
      await update(acc.id, { password_hash: hash, password_salt: salt, reset_token: null, reset_expires: null, email_verified: true });
      setSessionCookie(res, acc.id);
      return res.status(200).json({ ok: true, user: publicUser(Object.assign({}, acc, { email_verified: true })) });
    }
    return res.status(404).json({ error: "Azione sconosciuta" });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
