// api/auth-logout.js
// Funzione serverless (Vercel) per il logout: cancella semplicemente il
// cookie di sessione. Non serve nessuna configurazione extra per questo file.

const { clearSessionCookie } = require("./_auth-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa una richiesta POST" });
  }
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
};
