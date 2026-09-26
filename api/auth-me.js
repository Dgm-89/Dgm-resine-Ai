// api/auth-me.js
// Funzione serverless (Vercel) chiamata dal frontend a ogni apertura
// dell'app per capire se il visitatore ha già una sessione professionista
// attiva (cookie valido) e, in caso, restituire i suoi dati aggiornati
// (utile perché il piano/tier potrebbe essere cambiato nel frattempo).
// Se non c'è nessuna sessione valida, risponde semplicemente { user: null },
// che NON è un errore: succede per la maggior parte dei visitatori (privati
// o professionisti non ancora loggati).

const { getSupabaseConfig, supabaseRequest, readSessionCookie, verifySession, publicUser, sessionMatches } = require("./_auth-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Usa una richiesta GET" });
  }

  const { configured } = getSupabaseConfig();
  if (!configured) {
    // Non è un errore bloccante qui: semplicemente nessuno può essere loggato.
    return res.status(200).json({ user: null });
  }

  try {
    const token = readSessionCookie(req);
    const session = token ? verifySession(token) : null;
    if (!session || !session.sub) {
      return res.status(200).json({ user: null });
    }

    const found = await supabaseRequest(
      "/pro_accounts?id=eq." + encodeURIComponent(session.sub) + "&select=*",
      { method: "GET" }
    );
    const row = found.ok && Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
    if (!row || !sessionMatches(session, row)) return res.status(200).json({ user: null });
    return res.status(200).json({ user: publicUser(row) });
  } catch (err) {
    return res.status(200).json({ user: null });
  }
};
