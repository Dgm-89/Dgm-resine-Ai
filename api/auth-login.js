// api/auth-login.js
// Funzione serverless (Vercel) per il login di un account PROFESSIONISTA
// già registrato (email + password). Vedi api/_auth-lib.js per come
// configurare il database (Supabase) e le variabili d'ambiente necessarie.

const {
  getSupabaseConfig,
  supabaseRequest,
  verifyPassword,
  setSessionCookie,
  publicUser,
  emailEnabled,
} = require("./_auth-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa una richiesta POST" });
  }

  const { configured } = getSupabaseConfig();
  if (!configured) {
    return res.status(500).json({
      error:
        "Servizio account non ancora configurato: manca la connessione al database (vedi le istruzioni in api/_auth-lib.js).",
    });
  }

  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Email o password non corretti." });
  }

  try {
    const found = await supabaseRequest(
      "/pro_accounts?email=eq." + encodeURIComponent(email) + "&select=*",
      { method: "GET" }
    );
    if (!found.ok) {
      return res.status(502).json({ error: "Errore nella verifica dell'account. Riprova." });
    }
    const row = Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
    if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
      return res.status(401).json({ error: "Email o password non corretti." });
    }

    if (emailEnabled() && row.email_verified === false) {
      return res.status(403).json({ error: "Devi prima confermare la tua email: apri il messaggio che ti abbiamo inviato e clicca \"Conferma email\".", code: "email_not_verified" });
    }
    setSessionCookie(res, row.id);
    return res.status(200).json({ ok: true, user: publicUser(row) });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto durante l'accesso. Riprova." });
  }
};
