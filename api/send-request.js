// api/send-request.js
// Funzione serverless (pensata per Vercel) che invia via EMAIL, in automatico,
// la richiesta di preventivo compilata dal cliente nell'app — a differenza del
// bottone "Invia via WhatsApp" (che apre semplicemente wa.me con testo precompilato
// e resta invariato), qui il server invia davvero l'email a nome dell'app,
// includendo come ALLEGATO l'anteprima fotorealistica generata dall'AI (e, se
// disponibile, anche la foto originale caricata dal cliente). Un link "mailto:"
// normale non può allegare immagini: per questo serve un invio lato server.
//
// COSA FA QUESTO FILE, IN BREVE
// 1. Riceve dal frontend: indirizzo destinatario, oggetto, testo del messaggio
//    (lo stesso riepilogo già usato per WhatsApp) e le immagini in base64
//    (anteprima AI e/o foto del cliente, entrambe opzionali singolarmente)
// 2. Costruisce un'email HTML semplice a partire dal testo
// 3. Chiama l'API REST di Resend (resend.com) per inviare davvero l'email,
//    con le immagini come allegati
// 4. Restituisce al frontend { ok:true } se tutto è andato bene, oppure un
//    errore chiaro (che il frontend usa per attivare il fallback "mailto:")
//
// SERVE UN ACCOUNT RESEND (resend.com)
// - Resend è un servizio di invio email transazionali, con un piano gratuito
//   sufficiente per iniziare (qualche centinaio di email al mese).
// - Crea un account gratuito su https://resend.com, poi vai nella dashboard,
//   sezione "API Keys", e genera una nuova chiave API.
// - Non mettere MAI questa chiave nel codice del frontend/app: deve stare solo
//   qui, come variabile d'ambiente sul server (RESEND_API_KEY).
//
// COME SI CONFIGURA SU VERCEL
// 1. Metti questo file dentro la cartella "api/" del progetto (come
//    api/generate-preview.js)
// 2. Su Vercel, in "Settings > Environment Variables", aggiungi:
//      RESEND_API_KEY = la-tua-chiave-resend
// 3. Fai il deploy (vercel --prod). L'endpoint sarà disponibile su:
//      https://tuo-progetto.vercel.app/api/send-request
// 4. Il frontend chiama già "/api/send-request" in automatico dal bottone
//    "oppure invia via email": non serve altro collegamento manuale.
//
// SULL'INDIRIZZO MITTENTE ("from") USATO QUI SOTTO
// Questo file usa "onboarding@resend.dev", l'indirizzo di TEST condiviso che
// Resend mette a disposizione per iniziare subito, SENZA dover verificare un
// dominio: funziona da subito appena la RESEND_API_KEY è configurata. Il
// limite è che alcuni client email possono mostrare al destinatario un'etichetta
// tipo "via resend.dev" accanto al mittente, che è meno professionale per un
// uso definitivo.
// Quando l'azienda vorrà un mittente definitivo tipo "richieste@dgmresine.com",
// occorre:
//   1. Andare nella dashboard Resend, sezione "Domains"
//   2. Aggiungere il dominio "dgmresine.com" e seguire le istruzioni per
//      aggiungere alcuni record DNS (SPF/DKIM) forniti da Resend presso il
//      provider dove è registrato il dominio (es. pannello del provider hosting/DNS)
//   3. Attendere la verifica del dominio (di solito pochi minuti/ore)
//   4. Una volta verificato, aggiornare qui sotto la riga "from" con qualcosa
//      come: "DGM Resine <richieste@dgmresine.com>"
// Fino a quel momento, l'indirizzo di test "onboarding@resend.dev" resta
// perfettamente funzionante e non richiede alcuna azione.

const { currentAccount } = require("./_auth-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa una richiesta POST" });
  }
  // Solo chi ha un account può mandare richieste: il server non è un servizio email aperto.
  const acc = await currentAccount(req).catch(function () { return null; });
  if (!acc) return res.status(401).json({ error: "Accedi per inviare la richiesta." });

  const {
    subject,
    textSummary,
    replyTo,
    imageBase64,
    imageMime,
    customerPhotoBase64,
    customerPhotoMime
  } = req.body || {};

  // Il destinatario lo decide SOLO il server (variabile REQUEST_TO su Vercel).
  const toEmail = (process.env.REQUEST_TO || "info@dgmresine.com").trim();
  if (!textSummary || typeof textSummary !== "string") {
    return res.status(400).json({ error: "Richiesta vuota." });
  }
  if (textSummary.length > 6000) return res.status(400).json({ error: "Testo troppo lungo." });
  const tooBig = function (v) { return typeof v === "string" && v.length > 3_000_000; };
  if (tooBig(imageBase64) || tooBig(customerPhotoBase64)) return res.status(413).json({ error: "Foto troppo pesante." });
  const textWithAccount = textSummary + "\n\n— Inviata dall'account Rendrum: " + acc.email;

  // Le immagini non sono strettamente obbligatorie (l'email ha comunque senso
  // anche solo con il testo), ma segnaliamo nei log del server quando arrivano
  // entrambe mancanti, così è più facile accorgersi lato sviluppo se il frontend
  // non sta passando i dati attesi.
  if (!imageBase64 && !customerPhotoBase64) {
    console.log("send-request: nessuna immagine allegata (né anteprima AI né foto cliente), invio solo testo");
  }

  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({
      error: "RESEND_API_KEY non configurata sul server. Crea un account gratuito su resend.com, genera una API key nella dashboard, e aggiungila su Vercel in Settings > Environment Variables come RESEND_API_KEY, poi rifai il deploy."
    });
  }

  // Stessa logica difensiva di generate-preview.js per boiserieStyleRefImage:
  // il frontend potrebbe (per errore, o in futuro) inviare la stringa con il
  // prefisso "data:image/...;base64,", quindi lo togliamo qui in modo che
  // Resend riceva solo il base64 puro, come richiesto dalla sua API.
  function stripDataUriPrefix(value) {
    return typeof value === "string" ? value.replace(/^data:image\/\w+;base64,/, "") : null;
  }
  const imageBase64Clean = stripDataUriPrefix(imageBase64);
  const customerPhotoBase64Clean = stripDataUriPrefix(customerPhotoBase64);

  // Escaping HTML minimo e difensivo: il testo arriva da un form compilato
  // dal cliente (nome, note, ecc.), quindi potrebbe contenere caratteri come
  // < > & che romperebbero l'HTML dell'email se non escapati.
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const htmlBody = "<div style=\"font-family:sans-serif; font-size:14px; line-height:1.6; color:#111;\">"
    + escapeHtml(textWithAccount).replace(/\n/g, "<br>")
    + "</div>";

  const attachments = [
    imageBase64Clean ? { filename: "anteprima-ai.jpg", content: imageBase64Clean } : null,
    customerPhotoBase64Clean ? { filename: "foto-cliente.jpg", content: customerPhotoBase64Clean } : null
  ].filter(Boolean);

  // Se il cliente ha indicato la sua email nel form, la usiamo come "rispondi a":
  // così chi riceve la richiesta può premere "Rispondi" nella propria casella di
  // posta e scrivere direttamente al cliente, invece che all'indirizzo di test
  // Resend usato come mittente.
  const replyToClean = (typeof replyTo === "string" && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(replyTo.trim())) ? replyTo.trim() : null;
  const subjectClean = String(subject || "Nuova richiesta preventivo").replace(/[\r\n]+/g, " ").slice(0, 150);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // NOTA: indirizzo temporaneo di test Resend, finché non viene verificato
        // un dominio proprio (vedi commento in cima al file)
        from: (process.env.EMAIL_FROM || "Rendrum <onboarding@resend.dev>").trim(),
        to: [toEmail],
        subject: subjectClean,
        html: htmlBody,
        attachments: attachments,
        ...(replyToClean ? { reply_to: [replyToClean] } : {})
      })
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      // Risposta non JSON da Resend: restituiamo comunque il testo grezzo
      // così l'errore resta debuggabile invece di fallire in modo silenzioso.
      console.error("send-request resend", rawText.slice(0, 500));
      return res.status(502).json({ error: "Invio non riuscito, riprova tra poco." });
    }

    if (!response.ok) {
      console.error("send-request resend", data);
      return res.status(502).json({ error: "Invio non riuscito, riprova tra poco." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-request", err);
    return res.status(500).json({ error: "Invio non riuscito, riprova tra poco." });
  }
}
