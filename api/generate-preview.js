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

  const { imageBase64, mimeType, material, materialId, colorA, colorB, colorC, effetto, finitura, facadeLayout, context, boiserieStyle } = req.body || {};

  if (!imageBase64 || !material || !colorA) {
    return res.status(400).json({ error: "Dati mancanti: servono almeno imageBase64, material, colorA" });
  }

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY non configurata sul server" });
  }

  // Descrizione della TEXTURE/effetto materico specifica per ogni lavorazione,
  // così l'AI non genera solo "una superficie di quel colore" ma capisce davvero
  // che aspetto deve avere: resina spatolata liscia, resina con graniglie a vista
  // (Pietra/Terrazzo), resina marmorizzata, microcemento, ecc. Senza questo, foto
  // di materiali diversi rischiano di venire fuori quasi identiche, cambia solo
  // il colore piatto.
  const MATERIAL_TEXTURE = {
    monolith_spatolato: "resina spatolata monocomponente (linea Monolith), superficie continua, compatta, perfettamente liscia e uniforme, senza fughe né giunti, leggerissima texture materica data dalla spatolatura a mano",
    monolith_marmo: "resina spatolata effetto marmo (linea Monolith), superficie liscia con venature marmoree naturali, sfumature di tono e piccole nuvolature che ricordano il marmo lucidato, senza fughe",
    monolith_pietra: "resina spatolata effetto pietra (linea Monolith), superficie con graniglie minerali colorate ben visibili e distribuite in modo uniforme sulla superficie, texture granulare simile a un terrazzo fine, non liscia e piatta",
    monolith_terrazzo: "resina effetto terrazzo (linea Monolith), superficie con graniglie/scaglie di dimensioni miste e colori diversi ben visibili incorporate nella resina, tipico effetto terrazzo veneziano, texture chiaramente granulare",
    scale: "resina spatolata effetto liscio (stessa finitura Monolith Spatolato) applicata su gradini e alzate di una scala, superficie continua e uniforme senza fughe",
    microcemento: "microcemento applicato a spatola, superficie continua ma con texture materica leggera, piccole variazioni di tono naturali tipiche della spatolatura, non perfettamente piatta come la resina",
    imbiancatura: "pittura murale opaca stesa in modo uniforme sulla parete, finitura pittorica classica, nessuna texture materica particolare",
    decorazioni: "boiserie in legno applicata a parete"
  };

  // La boiserie NON è un semplice colore piatto: è una geometria di pannelli/doghe
  // applicata fisicamente sulla parete, quindi il prompt deve descrivere la forma
  // reale dei pannelli (rilievo, ombre, linee di giunzione), non solo il colore.
  const BOISERIE_STYLE_DESC = {
    arco: "boiserie con specchiatura ad arco: un pannello centrale con la parte superiore che termina con un arco a tutto sesto, incorniciato da una modanatura in rilievo che segue la curva, base/zoccolo dritto sotto, stile classico da ingresso o salone importante, con ombre morbide lungo la modanatura curva",
    specchiatura: "boiserie a specchiatura classica: pannelli rettangolari incorniciati da una vera modanatura sagomata in rilievo (non un bordo piatto, ma un profilo con più livelli, tipo cornice bugnata), disposti in una griglia regolare sulla parete, con ombre nette e realistiche lungo ogni cornice, stile boiserie tradizionale italiana",
    righe: "boiserie a righe geometriche scanalate: listelli verticali stretti con scanalatura arrotondata (effetto reeded/fluted), ritmo regolare e continuo dal pavimento al soffitto, ombre sottili e regolari in ogni scanalatura, stile contemporaneo minimale",
    fascia: "boiserie con fascia decorativa: una fascia orizzontale a circa 90-110cm da terra con un fregio/motivo decorativo ripetuto in leggero rilievo (es. losanghe o righe), sopra e sotto la fascia parete liscia o a pannelli semplici, stile decorativo con un punto focale orizzontale",
    cassettoni: "boiserie a cassettoni: pannelli quadrati profondi incassati nella parete, ciascuno con una cornice importante in forte rilievo (diversi livelli di modanatura) e un'ombra marcata e realistica sul fondo del cassettone, effetto tridimensionale scenografico, stile importante/classico",
    mezza: "mezza boiserie (wainscoting): solo la parte bassa della parete, fino a circa 100-120cm di altezza da terra, è rivestita con pannelli incorniciati; sopra c'è un cornicione/listello di passaggio orizzontale e poi la parete liscia dipinta o del colore scelto fino al soffitto",
    liscia: "boiserie liscia con cornice perimetrale: un grande pannello liscio e uniforme, bordato da un'unica cornice sottile ed elegante lungo il perimetro, nessuna ulteriore decorazione interna, stile minimale e pulito",
    nicchia: "boiserie con nicchia incassata: parete pannellata con un vano rettangolare incassato (profondità reale, con ombra interna scura), bordato da una cornice perimetrale, eventualmente con una piccola mensola/ripiano visibile all'interno del vano",
    specchio: "boiserie con inserto a specchio: pannello incorniciato con una vera lastra di specchio inserita al centro (superficie riflettente con un lieve riflesso/highlight diagonale), cornice in rilievo intorno allo specchio, stile elegante da ingresso o camera"
  };
  const boiserieDesc = BOISERIE_STYLE_DESC[boiserieStyle] || BOISERIE_STYLE_DESC.specchiatura;
  const textureDesc = materialId === "decorazioni"
    ? boiserieDesc
    : (MATERIAL_TEXTURE[materialId] || `una finitura in ${material}`);

  // Monolith Pietra e Terrazzo si posano SOLO a pavimento (non a parete): lo
  // diciamo esplicitamente all'AI così non applica la lavorazione anche ai muri
  // inquadrati nella foto.
  const FLOOR_ONLY_MATERIALS = ["monolith_pietra", "monolith_terrazzo"];
  const isFloorOnly = FLOOR_ONLY_MATERIALS.includes(materialId);
  const surfaceDesc = isFloorOnly
    ? "SOLO al pavimento inquadrato (questa lavorazione si posa esclusivamente a pavimento, non va applicata alle pareti anche se visibili nella foto)"
    : "alla superficie del pavimento/parete inquadrata";

  // Layout facciata (solo Imbiancatura Esterno): il "marcapiano" è la classica
  // soluzione a TRE fasce delle palazzine italiane — parte alta, la fascia del
  // marcapiano vero e proprio (spesso a contrasto), e la parte bassa/basamento —
  // mentre le righe sono più semplici, solo 2 colori alternati.
  const FACADE_LAYOUT_DESC = {
    marcapiano: `Dividi la facciata in tre fasce orizzontali sovrapposte, dall'alto verso il basso: (1) la parte alta della facciata nel colore "${colorA}"; (2) una fascia orizzontale decorativa più stretta, il "marcapiano" vero e proprio, ben visibile e nettamente distinta, nel colore "${colorC}"; (3) la parte bassa/il basamento della facciata (piano terra) nel colore "${colorB}". Le due linee di separazione devono essere orizzontali, nette e ben visibili, come nelle classiche palazzine italiane.`,
    righe_orizzontali: `Dipingi la facciata a bande orizzontali alternate, alternando il colore "${colorA}" e il colore "${colorB}" su strisce orizzontali di uguale altezza lungo tutta la facciata.`,
    righe_verticali: `Dipingi la facciata a bande verticali alternate, alternando il colore "${colorA}" e il colore "${colorB}" su strisce verticali di uguale larghezza lungo tutta la facciata.`
  };
  const isFacadeStyled = materialId === "imbiancatura" && context === "esterno" && facadeLayout && FACADE_LAYOUT_DESC[facadeLayout]
    && colorB && (facadeLayout !== "marcapiano" || colorC);

  // Costruzione del prompt descrittivo per il modello di editing immagine.
  const colorDesc = isFacadeStyled
    ? FACADE_LAYOUT_DESC[facadeLayout]
    : (colorB
      ? `un effetto nuvolato che miscela il colore "${colorA}" con il colore "${colorB}"`
      : `il colore uniforme "${colorA}"`);

  const sceneDesc = (materialId === "imbiancatura" && context === "esterno")
    ? "questa foto reale della facciata esterna di un edificio"
    : "questa foto reale di un ambiente domestico";

  // La boiserie, più di un semplice colore/texture piatta, è un elemento architettonico
  // con vero spessore fisico: senza istruzioni extra l'AI tende a "incollarla" sopra la
  // foto come un adesivo piatto invece di integrarla nella scena (prospettiva, luce,
  // ombre, mobili davanti). Questa nota extra spinge verso un risultato più fotografico
  // e meno da rendering 3D.
  const boiserieRealismNote = materialId === "decorazioni"
    ? " La boiserie deve avere volume e spessore reali, non un'immagine piatta incollata sopra la foto: segui esattamente la prospettiva e le linee di fuga della parete originale, fai cadere le ombre delle cornici/modanature/scanalature nella stessa direzione della luce già presente nella stanza, usa una texture di legno naturale con leggere variazioni di tono (mai un colore piatto e uniforme), e lascia che mobili/oggetti già presenti nella foto restino davanti alla boiserie dove la coprirebbero nella realtà. Il risultato finale deve sembrare una vera fotografia di una posa reale, non un rendering 3D né un adesivo digitale."
    : "";

  const prompt = [
    `Modifica ${sceneDesc}.`,
    `Applica ${surfaceDesc} la seguente lavorazione: ${textureDesc}.`,
    isFacadeStyled ? colorDesc : `Il colore/tonalità da usare è ${colorDesc}.`,
    `Finitura superficiale ${finitura} (${finitura === "lucido" ? "molto riflettente" : finitura === "opaco" ? "senza riflessi" : "leggermente satinata"}).`,
    isFacadeStyled
      ? `Mantieni identica la prospettiva, la luce, le ombre, gli infissi, il tetto e tutto il resto dell'edificio e dell'ambiente circostante: cambia solo il colore/texture della facciata indicata, in modo fotorealistico, come se fosse una vera tinteggiatura professionale.`
      : isFloorOnly
        ? `Mantieni identiche la prospettiva, la luce, le ombre, i mobili, e mantieni assolutamente INVARIATE tutte le pareti/muri della stanza (colore e materiale originali): cambia solo il pavimento, in modo fotorealistico, come se fosse una vera posa professionale.`
        : `Mantieni identica la prospettiva, la luce, le ombre, i mobili e tutto il resto della stanza: cambia solo il materiale/colore/texture della superficie indicata, in modo fotorealistico, come se fosse una vera posa professionale.`,
    boiserieRealismNote
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
