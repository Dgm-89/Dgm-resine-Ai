// api/generate-preview.js
// Funzione serverless (pensata per Vercel) che riceve la foto del cliente
// e la fa modificare da un modello AI di generazione/editing immagini,
// applicando in modo fotorealistico la lavorazione/colore/effetto/finitura scelti.
//
// COSA FA QUESTO FILE, IN BREVE
// 1. Riceve dal frontend: la foto (base64), lavorazione, colore/i, effetto, finitura
// 2. Costruisce un prompt che descrive la modifica da fare
// 3. Chiama l'API di Google Gemini (modello "gemini-3.1-flash-image-preview", evoluzione
//    di "nano banana"), pensato apposta per editing fotorealistico di foto esistenti
// 4. Restituisce al frontend l'immagine generata (base64), pronta da mostrare
//
// PRIMA DI USARLO IN PRODUZIONE
// - Verifica sulla documentazione ufficiale Google (ai.google.dev) l'endpoint e il
//   formato esatto della richiesta/risposta: le API di generazione immagini cambiano
//   spesso, questo codice è una base di partenza corretta nella struttura ma va
//   testata e aggiustata con una chiamata reale prima di andare online.
// - Serve una API key Gemini (gratuita per iniziare, a consumo dopo una soglia):
//   si ottiene su https://aistudio.google.com/apikey
// - Non mettere MAI la API key nel codice del frontend/app: deve stare solo qui,
//   come variabile d'ambiente sul server (GEMINI_API_KEY).
//
// COME SI DISTRIBUISCE (in breve, con Vercel — gratuito per iniziare)
// 1. Crea un account su vercel.com e installa "Vercel CLI" (o collega una repo GitHub)
// 2. Metti questo file dentro una cartella "api/" del progetto
// 3. Su Vercel, in "Settings > Environment Variables", aggiungi:
//      GEMINI_API_KEY = la-tua-chiave
// 4. Fai il deploy (vercel --prod). Otterrai un indirizzo tipo:
//      https://tuo-progetto.vercel.app/api/generate-preview
// 5. Nell'app, il bottone "Genera anteprima AI" andrà a chiamare quell'indirizzo
//    (questa parte la collego io appena il backend è online: mandami l'URL).

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa una richiesta POST" });
  }

  const { imageBase64, mimeType, material, colorA, colorB, effetto, finitura } = req.body || {};

  if (!imageBase64 || !material || !colorA) {
    return res.status(400).json({ error: "Dati mancanti: servono almeno imageBase64, material, colorA" });
  }

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY non configurata sul server" });
  }

  // Costruzione del prompt descrittivo per il modello di editing immagine.
  const colorDesc = colorB
    ? `un effetto nuvolato che miscela il colore "${colorA}" con il colore "${colorB}"`
    : `il colore uniforme "${colorA}"`;

  const prompt = [
    `Modifica questa foto reale di un ambiente domestico.`,
    `Applica alla superficie del pavimento/parete inquadrata una finitura in ${material},`,
    `con ${colorDesc}, effetto ${effetto === "nuvolato" ? "nuvolato/marmorizzato" : "liscio e uniforme"},`,
    `finitura ${finitura} (${finitura === "lucido" ? "molto riflettente" : finitura === "opaco" ? "senza riflessi" : "leggermente satinata"}).`,
    `Mantieni identica la prospettiva, la luce, le ombre, i mobili e tutto il resto della stanza:`,
    `cambia solo il materiale/colore della superficie indicata, in modo fotorealistico,`,
    `come se fosse una vera posa professionale.`
  ].join(" ");

  // L'immagine base64 arriva dal frontend già ridimensionata, ma per sicurezza
  // rifiutiamo esplicitamente payload anomali invece di lasciare che falliscano
  // in modo silenzioso più avanti (Vercel rifiuta comunque richieste troppo grandi,
  // ma con un errore poco chiaro per l'utente finale).
  if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
    return res.status(400).json({ error: "Immagine mancante o non valida" });
  }
  if (imageBase64.length > 8_000_000) {
    return res.status(413).json({ error: "La foto è troppo pesante, prova con una foto più piccola" });
  }

  let apiUrl;
  try {
    apiUrl = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent"
    );
    apiUrl.searchParams.set("key", apiKey);
  } catch (err) {
    return res.status(500).json({ error: "Configurazione AI non valida (URL malformato)", details: String(err) });
  }

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType || "image/jpeg",
                  data: imageBase64 // base64 SENZA il prefisso "data:image/...;base64,"
                }
              }
            ]
          }
        ]
      })
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      // La risposta non era JSON (es. pagina di errore intermedia): non tentiamo
      // di interpretarla oltre, restituiamo un errore chiaro invece di far
      // fallire il parsing lato frontend con un messaggio criptico.
      return res.status(502).json({
        error: "Risposta non valida dal servizio AI",
        details: rawText.slice(0, 500)
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: "Errore dal servizio AI", details: data });
    }

    // Il modello risponde con una lista di "parts": cerchiamo quella che contiene l'immagine generata.
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inline_data || p.inlineData);
    const inline = imagePart?.inline_data || imagePart?.inlineData;

    if (!inline || !inline.data) {
      return res.status(502).json({ error: "Il modello non ha restituito un'immagine", details: data });
    }

    return res.status(200).json({
      imageBase64: inline.data,
      mimeType: inline.mime_type || inline.mimeType || "image/png"
    });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto lato server", details: String(err && err.message ? err.message : err) });
  }
}
