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

  const { imageBase64, mimeType, material, materialId, colorA, colorAHex, colorB, colorBHex, colorC, colorCHex, effetto, finitura, facadeLayout, context, boiserieStyle, boiserieHeight, addNicchia, boiserieStyleRefImage, resinaArea } = req.body || {};

  if (!imageBase64 || !material || !colorA) {
    return res.status(400).json({ error: "Dati mancanti: servono almeno imageBase64, material, colorA" });
  }

  // Riferimento colore per il prompt: include il codice esadecimale esatto quando
  // disponibile, così l'AI ha un target numerico preciso invece di dover indovinare
  // la tonalità solo dal nome. Fallback graceful al solo nome se l'hex non arriva
  // (retro-compatibilità con frontend più vecchi durante il rollout).
  function colorRef(name, hex) {
    return hex ? `"${name}" (codice esadecimale esatto ${hex})` : `"${name}"`;
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
    monolith_spatolato: "resina spatolata monocomponente color chiaro/avorio, superficie continua, compatta e uniforme, con leggerissime tracce direzionali lasciate dalla spatolatura a mano ancora visibili in controluce, finitura satinata, senza fughe né giunti",
    monolith_marmo: "resina spatolata effetto marmo, superficie liscia con venature marmoree naturali, sfumature di tono e piccole nuvolature che ricordano il marmo lucidato, senza fughe",
    monolith_pietra: "resina spatolata effetto pietra, superficie con graniglie minerali colorate ben visibili e distribuite in modo uniforme sulla superficie, texture granulare simile a un terrazzo fine, non liscia e piatta",
    monolith_terrazzo: "resina effetto terrazzo, superficie con graniglie/scaglie di dimensioni miste e colori diversi ben visibili incorporate nella resina, tipico effetto terrazzo veneziano, texture chiaramente granulare",
    scale: "resina spatolata effetto liscio (stessa finitura Resina Spatolata) applicata su gradini e alzate di una scala, superficie continua e uniforme con leggerissime tracce direzionali di spatolatura, finitura satinata, senza fughe",
    microcemento: "microcemento applicato a spatola/frattazzo, superficie con evidenti segni di lavorazione circolari e radiali lasciati dal frattazzo ancora percepibili, leggere variazioni di tono naturali (non un colore perfettamente piatto), finitura satinata-opaca, non liscia e piatta come la resina",
    imbiancatura: "pittura murale opaca stesa in modo uniforme sulla parete, finitura pittorica classica, nessuna texture materica particolare",
    decorazioni: "boiserie in legno applicata a parete",
    resina_haccp: "resina industriale bianca lucida ad alta resistenza chimica e meccanica, superficie liscia, compatta e priva di fughe o giunti, con raccordi a raggio sanitario (curvi, senza spigoli vivi) tra pavimento e pareti dove visibili, tipica dei pavimenti certificati HACCP per cucine professionali e industria alimentare, finitura lucida uniforme",
    parquet: "parquet in legno vero posato a pavimento, tavole/doghe rettangolari disposte in modo ordinato (es. posa a correre), con leggera variazione naturale di tono e venatura del legno visibile tra una tavola e l'altra, sottili fughe/giunti lineari ben visibili nella direzione di posa, superficie opaca-satinata calda e materica tipica del legno trattato, non una superficie piatta e uniforme come la resina",
    piastrelle: "pavimentazione in piastrelle ceramiche/gres porcellanato, moduli quadrati o rettangolari regolari con sottili fughe dritte e uniformi ben visibili tra una piastrella e l'altra secondo una griglia regolare, superficie piana con leggerissima variazione naturale di tono tra i pezzi, texture e fughe chiaramente riconoscibili, non una superficie continua senza giunti come la resina"
  };

  // Effetti di superficie aggiuntivi (Materico/Corten): si sommano alla texture
  // base del materiale (es. Resina Spatolata + Materico), non la sostituiscono.
  // "Liscio" è il default e non aggiunge nulla (la texture base è già liscia).
  const EFFETTO_TEXTURE = {
    materico: " con un effetto materico superficiale sovrapposto: texture ruvida e tattile, rilievo irregolare ben visibile, variazioni di tono chiare e scure che si alternano in modo naturale e non simmetrico sulla superficie, aspetto grezzo e tridimensionale, decisamente non liscio né piatto",
    corten: " con un effetto Corten sovrapposto: base cromatica ocra/ruggine, con macchie e chiazze scure irregolari che imitano l'ossidazione naturale dell'acciaio Corten, pattern asimmetrico e naturale (mai simmetrico, mai ripetitivo o a griglia), superficie opaca"
  };
  const EFFETTO_MATERIALS = ["monolith_spatolato", "monolith_marmo", "microcemento", "scale"];

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
    nicchia: "un SINGOLO vano rettangolare incassato nella parete (profondità reale, con ombra interna scura), bordato da una sottile cornice perimetrale in rilievo, eventualmente con una piccola mensola/ripiano visibile all'interno del vano. IMPORTANTE: applica SOLO questo vano/nicchia come elemento puntuale, NON rivestire il resto della parete con pannelli: il resto della parete deve restare invariato (stesso colore/materiale della foto originale)",
    specchio: "boiserie con inserto a specchio: pannello incorniciato con una vera lastra di specchio inserita al centro (superficie riflettente con un lieve riflesso/highlight diagonale), cornice in rilievo intorno allo specchio, stile elegante da ingresso o camera",
    doghe: "boiserie a doghe verticali in legno: listelli verticali stretti e ravvicinati (profilo squadrato tipo listone, non arrotondato), accostati l'uno all'altro dal pavimento al soffitto con una sottile fuga d'ombra tra una doga e l'altra, superficie calda e materica con venatura del legno naturale, stile contemporaneo caldo",
    pannello: "boiserie a pannello semplice: 2-4 pannelli rettangolari LARGHI (proporzione orizzontale, MAI quadrati, MAI una fitta griglia di tanti riquadri piccoli tipo scacchiera) per ogni parete inquadrata, ciascuno largo almeno il doppio della sua altezza, incorniciati da una modanatura sottile e lineare (profilo semplice, NON bugnato, NON scolpito, niente cornici multilivello elaborate), superficie interna liscia, geometria essenziale e minimale, ombre leggere e nette solo lungo il bordo della cornice"
  };
  const boiserieDesc = BOISERIE_STYLE_DESC[boiserieStyle] || BOISERIE_STYLE_DESC.specchiatura;
  const baseTextureDesc = materialId === "decorazioni"
    ? boiserieDesc
    : (MATERIAL_TEXTURE[materialId] || `una finitura in ${material}`);
  const effettoAddon = (EFFETTO_MATERIALS.includes(materialId) && EFFETTO_TEXTURE[effetto]) ? EFFETTO_TEXTURE[effetto] : "";
  const textureDesc = baseTextureDesc + effettoAddon;

  // Monolith Pietra e Terrazzo si posano SOLO a pavimento (non a parete): lo
  // diciamo esplicitamente all'AI così non applica la lavorazione anche ai muri
  // inquadrati nella foto.
  const FLOOR_ONLY_MATERIALS = ["monolith_pietra", "monolith_terrazzo", "parquet", "piastrelle"];
  const isFloorOnly = FLOOR_ONLY_MATERIALS.includes(materialId);

  // Per la categoria "Resine" (monolith), l'utente ora sceglie esplicitamente DOVE
  // applicare la resina: solo pavimento, solo pareti (rivestimento), o entrambi
  // insieme ("tutto resinato"). Questo si applica SOPRA/oltre al vincolo esistente
  // isFloorOnly (Pietra/Terrazzo restano comunque solo pavimento anche se qualcuno
  // forzasse "rivestimento" via API diretta, ma la UI già filtra questo caso).
  const RESINA_AREA_DESC = {
    pavimento: "SOLO al pavimento inquadrato (non applicare alle pareti anche se visibili nella foto)",
    rivestimento: "SOLO alle pareti inquadrate (non applicare al pavimento anche se visibile nella foto)",
    tutto: "sia al pavimento che alle pareti inquadrate nella foto, in modo uniforme e continuo su entrambe le superfici, come un ambiente completamente resinato dal pavimento alle pareti"
  };
  const resinaAreaDesc = (materialId && materialId.indexOf("monolith") === 0 && resinaArea && RESINA_AREA_DESC[resinaArea])
    ? RESINA_AREA_DESC[resinaArea]
    : null;

  const surfaceDesc = isFloorOnly
    ? "SOLO al pavimento inquadrato (questa lavorazione si posa esclusivamente a pavimento, non va applicata alle pareti anche se visibili nella foto)"
    : (resinaAreaDesc || "alla superficie del pavimento/parete inquadrata");

  // Layout facciata (solo Imbiancatura Esterno): il "marcapiano" è la classica
  // soluzione a TRE fasce delle palazzine italiane — parte alta, la fascia del
  // marcapiano vero e proprio (spesso a contrasto), e la parte bassa/basamento —
  // mentre le righe sono più semplici, solo 2 colori alternati.
  const FACADE_LAYOUT_DESC = {
    marcapiano: `Dividi la facciata in tre fasce orizzontali sovrapposte, dall'alto verso il basso: (1) la parte alta della facciata nel colore ${colorRef(colorA, colorAHex)}; (2) una fascia orizzontale decorativa più stretta, il "marcapiano" vero e proprio, ben visibile e nettamente distinta, nel colore ${colorRef(colorC, colorCHex)}; (3) la parte bassa/il basamento della facciata (piano terra) nel colore ${colorRef(colorB, colorBHex)}. Le due linee di separazione devono essere orizzontali, nette e ben visibili, come nelle classiche palazzine italiane.`,
    righe_orizzontali: `Dipingi la facciata a bande orizzontali alternate, alternando il colore ${colorRef(colorA, colorAHex)} e il colore ${colorRef(colorB, colorBHex)} su strisce orizzontali di uguale altezza lungo tutta la facciata.`,
    righe_verticali: `Dipingi la facciata a bande verticali alternate, alternando il colore ${colorRef(colorA, colorAHex)} e il colore ${colorRef(colorB, colorBHex)} su strisce verticali di uguale larghezza lungo tutta la facciata.`
  };
  const isFacadeStyled = materialId === "imbiancatura" && context === "esterno" && facadeLayout && FACADE_LAYOUT_DESC[facadeLayout]
    && colorB && (facadeLayout !== "marcapiano" || colorC);

  // Costruzione del prompt descrittivo per il modello di editing immagine.
  const colorDesc = isFacadeStyled
    ? FACADE_LAYOUT_DESC[facadeLayout]
    : (colorB
      ? `un effetto nuvolato che miscela il colore ${colorRef(colorA, colorAHex)} con il colore ${colorRef(colorB, colorBHex)}`
      : `il colore uniforme ${colorRef(colorA, colorAHex)}`);

  const sceneDesc = (materialId === "imbiancatura" && context === "esterno")
    ? "questa foto reale della facciata esterna di un edificio"
    : "questa foto reale di un ambiente domestico";

  // La boiserie, più di un semplice colore/texture piatta, è un elemento architettonico
  // con vero spessore fisico: senza istruzioni extra l'AI tende a "incollarla" sopra la
  // foto come un adesivo piatto invece di integrarla nella scena (prospettiva, luce,
  // ombre, mobili davanti). Questa nota extra spinge verso un risultato più fotografico
  // e meno da rendering 3D.
  const boiserieRealismNote = materialId === "decorazioni"
    ? " La boiserie deve avere volume e spessore reali, non un'immagine piatta incollata sopra la foto: segui esattamente la prospettiva e le linee di fuga della parete originale, fai cadere le ombre delle cornici/modanature/scanalature nella stessa direzione della luce già presente nella stanza, usa una texture di legno naturale con leggere variazioni di tono (mai un colore piatto e uniforme), e lascia che mobili/oggetti già presenti nella foto restino davanti alla boiserie dove la coprirebbero nella realtà. IMPORTANTE: se nella foto sono presenti porte, finestre, prese elettriche, interruttori o altri elementi già esistenti, NON coprirli né trasformarli in pannellatura: devono restare riconoscibili esattamente come nella foto originale, e la boiserie va applicata solo all'area di parete libera intorno a loro. Il risultato finale deve sembrare una vera fotografia di una posa reale, non un rendering 3D né un adesivo digitale."
    : "";

  // Nicchia incassata: opzione indipendente dalla boiserie, pensata soprattutto per
  // bagno/doccia (Microcemento, Monolith Spatolato/Marmo). Elemento puntuale, non va
  // a coprire il resto della superficie, e include di default una striscia LED
  // (molto richiesta oggi nelle nicchie doccia moderne).
  const nicchiaNote = addNicchia
    ? " Aggiungi inoltre, in un punto sensato della superficie inquadrata (tipicamente sulla parete doccia se è un bagno), UN SINGOLO vano rettangolare incassato (nicchia) con profondità reale, bordato da una sottile cornice, con un piccolo ripiano interno e una striscia LED nascosta lungo il bordo superiore o laterale della nicchia che illumina delicatamente l'interno del vano con una luce calda. Applica questo elemento SOLO come dettaglio puntuale: non rivestire né alterare il resto della parete, che deve mantenere la stessa lavorazione/colore già applicati nel resto della foto."
    : "";

  // Altezza della boiserie a pannello: prova mirata solo su questo stile, gli
  // altri stili boiserie non hanno questa scelta e non ricevono questa nota.
  const pannelloHeightNote = (materialId === "decorazioni" && boiserieStyle === "pannello" && boiserieHeight)
    ? (boiserieHeight === "alta"
      ? " La boiserie a pannello deve coprire l'INTERA altezza della parete, dal pavimento fino al soffitto (o fino alla cornice/cornicione superiore se presente nella foto), senza lasciare parte di parete nuda sopra."
      : " La boiserie a pannello deve coprire SOLO la parte bassa della parete, per un'altezza di circa 90-100cm da terra (tipica altezza a zoccolo/parete bassa), con una cornice/modanatura orizzontale netta che segna la fine della boiserie: sopra questa linea la parete resta identica all'originale (stesso colore/materiale della foto di partenza), NON estendere la boiserie oltre questa altezza.")
    : "";

  // Rinforzo esplicito: quando abbiamo almeno un codice hex, ribadiamo che va
  // rispettato con precisione, non solo usato come vago riferimento.
  const hasAnyHex = Boolean(colorAHex || colorBHex || colorCHex);
  const colorFidelityNote = hasAnyHex
    ? " ATTENZIONE, REGOLA VINCOLANTE SUL COLORE: usa ESATTAMENTE e SOLO il/i codice/i colore esadecimale indicato/i sopra, non un colore simile, non un colore della stessa famiglia, non il colore che ti sembra stia meglio nella scena: il codice esadecimale è un vincolo numerico assoluto, non un'ispirazione. Non sostituire mai la tonalità richiesta con un'altra tonalità (es. se viene richiesto un colore bordeaux/prugna scuro, il risultato NON deve mai diventare verde, blu o qualsiasi altra famiglia di colore diversa da quella del codice indicato). L'unica variazione ammessa è la normale resa fotografica della luce/ombra ambientale sopra quella tonalità esatta, mai un cambio di tonalità. Inoltre non modificare nient'altro rispetto alla richiesta: mantieni la finitura (lucido/opaco/satinato) esattamente come indicato, e non cambiare materiale, texture o finitura in modo diverso da quanto specificato."
    : "";

  // Rinforzo generale, sempre incluso (non condizionato a un materiale/contesto
  // specifico): oltre alle singole note di preservazione già presenti nei rami
  // facciata/pavimento/default qui sotto, questa regola assoluta copre TUTTI i casi
  // e ribadisce che l'unica area modificabile è quella esplicitamente descritta.
  const bothSurfacesTargeted = resinaArea === "tutto";
  const globalPreservationNote = bothSurfacesTargeted
    ? " REGOLA ASSOLUTA: non alterare in nessun modo altri elementi della foto oltre a quanto esplicitamente richiesto in queste istruzioni — non spostare, aggiungere, rimuovere o modificare mobili, oggetti, porte, finestre, prese elettriche, interruttori, quadri, piante, altre pareti non indicate, illuminazione naturale o artificiale, inquadratura o prospettiva. In questo caso sia il pavimento SIA le pareti inquadrate sono l'area da trattare (resina applicata su entrambi in modo coerente e continuo); resta invariato tutto il resto (mobili, infissi, oggetti, ecc.)."
    : " REGOLA ASSOLUTA: non alterare in nessun modo altri elementi della foto oltre a quanto esplicitamente richiesto in queste istruzioni — non spostare, aggiungere, rimuovere o modificare mobili, oggetti, porte, finestre, prese elettriche, interruttori, quadri, piante, pavimenti (a meno che non sia il pavimento l'elemento richiesto), altre pareti non indicate, illuminazione naturale o artificiale, inquadratura o prospettiva. L'unica area che puoi modificare è quella esplicitamente descritta sopra.";

  // Quando inviamo anche la foto di riferimento dello stile di boiserie (vedi la
  // terza "part" inline_data più sotto), dobbiamo spiegare al modello l'ordine e il
  // ruolo delle due immagini: altrimenti rischia di confondere le due foto o di
  // copiare anche colore/ambiente dalla seconda immagine invece che solo la geometria.
  const boiserieStyleRefImageClean = typeof boiserieStyleRefImage === "string"
    ? boiserieStyleRefImage.replace(/^data:image\/\w+;base64,/, "")
    : null;
  const boiserieStyleRefNote = boiserieStyleRefImageClean
    ? " IMPORTANTE SUL RIFERIMENTO VISIVO: ti sono state fornite DUE immagini. La PRIMA immagine è la foto reale del cliente da modificare. La SECONDA immagine è un riferimento visivo ESATTO della geometria/stile di boiserie da applicare (forma, proporzioni e disposizione dei pannelli, tipo di cornice/modanatura): replica FEDELMENTE quella geometria e quelle proporzioni sulla parete della prima foto. Usa la seconda immagine SOLO come riferimento per la FORMA/GEOMETRIA dei pannelli, non per il colore né per l'ambiente circostante: colore e materiale seguono invece le istruzioni indicate sopra nel testo, non l'immagine di riferimento."
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
    boiserieRealismNote,
    pannelloHeightNote,
    nicchiaNote,
    boiserieStyleRefNote,
    colorFidelityNote,
    globalPreservationNote
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
    // Parti della richiesta a Gemini: testo del prompt + foto del cliente, e in più
    // (solo per boiserie, quando il frontend ce l'ha inviata) la foto di riferimento
    // dello stile scelto, come TERZA part, DOPO la foto del cliente — l'ordine è
    // importante perché il prompt sopra spiega esplicitamente "PRIMA immagine" /
    // "SECONDA immagine" facendo riferimento a questa stessa sequenza.
    const contentParts = [
      { text: prompt },
      {
        inline_data: {
          mime_type: mimeType || "image/jpeg",
          data: imageBase64 // base64 SENZA il prefisso "data:image/...;base64,"
        }
      }
    ];
    if (boiserieStyleRefImageClean) {
      contentParts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: boiserieStyleRefImageClean
        }
      });
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: contentParts
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
