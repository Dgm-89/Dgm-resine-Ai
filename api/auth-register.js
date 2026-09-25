// api/auth-register.js
// Funzione serverless (Vercel) per la registrazione di un nuovo account,
// sia PROFESSIONISTA che PRIVATO (email, password, nome/ragione sociale,
// piano scelto — i 3 piani Basic/Medium/Pro sono gli stessi per entrambi).
// Vedi api/_auth-lib.js per come configurare il database (Supabase) e le
// variabili d'ambiente necessarie — senza quella configurazione questo
// endpoint risponde con un errore chiaro invece di andare in crash.
//
// Il frontend chiama questo endpoint dal modulo di accesso → tab
// "Registrati" nell'app, dove l'utente sceglie anche se è un Privato o un
// Professionista. Se la registrazione va a buon fine, viene creata una
// sessione (cookie) così l'utente risulta subito loggato, come se avesse
// anche fatto login.

const {
  getSupabaseConfig,
  supabaseRequest,
  hashPassword,
  setSessionCookie,
  publicUser,
  emailEnabled,
  newToken,
  sendVerifyEmail,
} = require("./_auth-lib");

const VALID_TIERS = ["basic", "medium", "pro"];
const VALID_ACCOUNT_TYPES = ["professionista", "privato"];

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
  const accountType = VALID_ACCOUNT_TYPES.includes(body.accountType) ? body.accountType : "professionista";
  // companyName contiene la ragione sociale per i professionisti, oppure
  // nome e cognome per i privati: stesso campo, etichetta diversa lato form.
  const companyName = String(body.companyName || "").trim();
  const piva = accountType === "privato" ? "" : String(body.piva || "").trim();
  const phone = String(body.phone || "").trim();
  const tier = VALID_TIERS.includes(body.tier) ? body.tier : "basic";

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk || password.length < 6 || !companyName) {
    return res.status(400).json({
      error:
        accountType === "privato"
          ? "Dati mancanti o non validi: servono nome e cognome, email valida e password (min 6 caratteri)."
          : "Dati mancanti o non validi: servono ragione sociale, email valida e password (min 6 caratteri).",
    });
  }

  try {
    // Controlla se esiste già un account con questa email.
    const existing = await supabaseRequest(
      "/pro_accounts?email=eq." + encodeURIComponent(email) + "&select=id",
      { method: "GET" }
    );
    if (!existing.ok) {
      return res.status(502).json({ error: "Errore nel controllo dell'account esistente. Riprova." });
    }
    if (Array.isArray(existing.data) && existing.data.length > 0) {
      return res.status(409).json({ error: "Esiste già un account con questa email." });
    }

    const { hash, salt } = hashPassword(password);
    const verifyToken = newToken();

    const inserted = await supabaseRequest("/pro_accounts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([
        {
          email: email,
          password_hash: hash,
          password_salt: salt,
          account_type: accountType,
          company_name: companyName,
          piva: piva || null,
          phone: phone || null,
          tier: tier,
          email_verified: !emailEnabled(),
          verify_token: emailEnabled() ? verifyToken : null,
        },
      ]),
    });

    if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) {
      return res.status(502).json({ error: "Errore nella creazione dell'account. Riprova." });
    }

    const newUser = inserted.data[0];
    // Con le email attive l'account resta bloccato finché non si conferma l'email.
    if (emailEnabled()) {
      const sent = await sendVerifyEmail(req, email, verifyToken);
      return res.status(200).json({ ok: true, needsVerification: true, emailSent: sent, email: email });
    }
    setSessionCookie(res, newUser.id);
    return res.status(200).json({ ok: true, user: publicUser(newUser) });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto durante la registrazione. Riprova." });
  }
};
