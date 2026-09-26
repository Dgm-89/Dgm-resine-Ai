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

const { paymentsEnabled, currentAccount, supabaseRequest, PLAN_LIMITS } = require("./_auth-lib");
const PLANS_LIMIT = (tier) => PLAN_LIMITS[tier] || 0;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa una richiesta POST" });
  }

  // I testi che arrivano dal browser finiscono nel prompt dell'AI: niente a capo
  // e lunghezza limitata, così nessuno può usare l'app per chiedere altre immagini.
  if (req.body && typeof req.body === "object") {
    const IMG_FIELDS = ["imageBase64", "boiserieStyleRefImage", "colorCardImage", "posaRefImage"];
    Object.keys(req.body).forEach(function (k) {
      if (IMG_FIELDS.includes(k)) return;
      if (typeof req.body[k] === "string") req.body[k] = req.body[k].replace(/[\r\n\t]+/g, " ").replace(/[<>{}]/g, "").slice(0, 80);
    });
  }
  const { imageBase64, mimeType, material, materialId, colorA, colorAHex, colorB, colorBHex, colorC, colorCHex, colorDavanzali, colorDavanzaliHex, colorSottotetto, colorSottotettoHex, colorPlafone, colorPlafoneHex, effettoScatola, colorTetto, colorTettoHex, colorCornici, colorCorniciHex, colorBalconi, colorBalconiHex, colorSerramenti, colorSerramentiHex, colorRighe, colorRigheHex, effetto, finitura, facadeLayout, righeExtent, righeOrientamento, righeZona, context, boiserieStyle, boiserieHeight, addDavanzali, addMarcapiano, addSottotetto, addTetto, addCornici, addBalconi, addSerramenti, addRighe, boiserieStyleRefImage, resinaArea, granigliaLayout, parquetPosa, grana, righeSpessore, colorCardImage, posaRefImage, spcLine, step, paddedBands } = req.body || {};

  if (!imageBase64 || !material || !colorA) {
    return res.status(400).json({ error: "Dati mancanti: servono almeno imageBase64, material, colorA" });
  }

  // Accesso: per generare serve SEMPRE un account (le anteprime costano).
  // Con i pagamenti attivi servono anche abbonamento attivo e anteprime rimaste nel mese.
  let quotaAcc = null, quotaMonth = null, reserved = false, refunded = false;
  quotaAcc = await currentAccount(req).catch(function () { return null; });
  if (!quotaAcc) return res.status(401).json({ error: "Per creare l'anteprima accedi o registrati.", code: "login_required" });
  if (paymentsEnabled()) {
    if (!["active", "trialing"].includes(quotaAcc.subscription_status)) {
      return res.status(402).json({ error: "Il tuo abbonamento non è attivo: attivalo per creare le anteprime.", code: "subscription_required" });
    }
    quotaMonth = new Date().toISOString().slice(0, 7);
    const limit = PLANS_LIMIT(quotaAcc.tier);
    // Prenotazione atomica dell'anteprima nel database (funzione use_preview):
    // anche 50 richieste in parallelo non possono superare il limite.
    const rpc = await supabaseRequest("/rpc/use_preview", { method: "POST", body: JSON.stringify({ p_id: quotaAcc.id, p_month: quotaMonth, p_limit: limit }) }).catch(function () { return { ok: false }; });
    if (rpc.ok) {
      if (rpc.data === null || rpc.data === undefined) {
        return res.status(429).json({ error: "Hai usato tutte le " + limit + " anteprime del tuo piano per questo mese. Passa a un piano superiore o attendi il mese prossimo.", code: "quota_exceeded" });
      }
      reserved = true;
    } else {
      // Funzione SQL non ancora creata: controllo semplice come prima.
      const used = quotaAcc.usage_month === quotaMonth ? (quotaAcc.usage_count || 0) : 0;
      if (used >= limit) return res.status(429).json({ error: "Hai usato tutte le " + limit + " anteprime del tuo piano per questo mese. Passa a un piano superiore o attendi il mese prossimo.", code: "quota_exceeded" });
      await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(quotaAcc.id), { method: "PATCH", body: JSON.stringify({ usage_month: quotaMonth, usage_count: used + 1 }) }).catch(function () {});
      reserved = true;
    }
    // Se la generazione poi fallisce, l'anteprima viene restituita.
    const origJson = res.json.bind(res);
    res.json = function (payload) {
      if (reserved && !refunded && res.statusCode >= 400) {
        refunded = true;
        return supabaseRequest("/rpc/release_preview", { method: "POST", body: JSON.stringify({ p_id: quotaAcc.id, p_month: quotaMonth }) })
          .catch(function () {}).then(function () { return origJson(payload); });
      }
      return origJson(payload);
    };
  }
  async function countUsage() { /* già conteggiata all'inizio */ }

  // Riferimento colore per il prompt: include il codice esadecimale esatto quando
  // disponibile, così l'AI ha un target numerico preciso invece di dover indovinare
  // la tonalità solo dal nome. Fallback graceful al solo nome se l'hex non arriva
  // (retro-compatibilità con frontend più vecchi durante il rollout).
  function colorRef(name, hex) {
    return hex ? `"${name}" (codice esadecimale esatto ${hex})` : `"${name}"`;
  }

  // Fornitore AI: OpenAI (GPT Image 2.5, primo nella classifica di editing di
  // Artificial Analysis) se è configurata OPENAI_API_KEY, altrimenti Google
  // Gemini. Si può forzare con la variabile AI_PROVIDER = "openai" | "gemini".
  const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  const provider = ((process.env.AI_PROVIDER || "").trim().toLowerCase()) || (openaiKey ? "openai" : "gemini");
  if (provider === "openai" && !openaiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY non configurata sul server" });
  }
  if (provider !== "openai" && !apiKey) {
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
    spc: "pavimento SPC (Stone Plastic Composite) flottante a incastro: doghe o piastrelle rigide con pellicola decorativa ad alta definizione (effetto legno, pietra, cemento o marmo a seconda del colore indicato) protetta da uno strato d'usura, superficie opaca-satinata realistica, sottili giunti a incastro ben allineati tra un elemento e l'altro, senza fughe stuccate, posato su tutto il pavimento",
    parquet: "parquet in legno vero posato a pavimento, tavole/doghe/listelli disposti in modo ordinato secondo lo schema di posa indicato, con leggera variazione naturale di tono e venatura del legno visibile tra una tavola e l'altra, sottili fughe/giunti lineari ben visibili nella direzione di posa, superficie opaca-satinata calda e materica tipica del legno trattato, non una superficie piatta e uniforme come la resina",
    piastrelle: "pavimentazione in piastrelle ceramiche/gres porcellanato, moduli quadrati o rettangolari regolari con sottili fughe dritte e uniformi ben visibili tra una piastrella e l'altra secondo una griglia regolare, superficie piana con leggerissima variazione naturale di tono tra i pezzi, texture e fughe chiaramente riconoscibili, non una superficie continua senza giunti come la resina",
    graniglia_esterni: "pavimentazione decorativa da esterno in resina drenante con graniglie/sassolini naturali di piccola pezzatura ben visibili e distribuiti in modo uniforme e denso su tutta la superficie, texture granulare e materica (non liscia né piatta), tipica dei rivestimenti decorativi per terrazzi, vialetti, bordi piscina e rampe carrabili, superficie compatta ma con i singoli sassolini chiaramente riconoscibili, finitura leggermente lucida come resina trasparente che lega la graniglia"
  };

  // Effetti di superficie aggiuntivi (Materico/Corten): si sommano alla texture
  // base del materiale (es. Resina Spatolata + Materico), non la sostituiscono.
  // "Liscio" è il default e non aggiunge nulla (la texture base è già liscia).
  const EFFETTO_TEXTURE = {
    materico: " con un effetto materico superficiale sovrapposto: texture ruvida e tattile, rilievo irregolare ben visibile, variazioni di tono chiare e scure che si alternano in modo naturale e non simmetrico sulla superficie, aspetto grezzo e tridimensionale, decisamente non liscio né piatto",
    corten: " con un effetto Corten sovrapposto: base cromatica ocra/ruggine, con macchie e chiazze scure irregolari che imitano l'ossidazione naturale dell'acciaio Corten, pattern asimmetrico e naturale (mai simmetrico, mai ripetitivo o a griglia), superficie opaca"
  };
  const EFFETTO_MATERIALS = ["monolith_spatolato", "microcemento", "scale"];

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
    specchio: "boiserie con inserto a specchio: pannello incorniciato con una vera lastra di specchio inserita al centro (superficie riflettente con un lieve riflesso/highlight diagonale), cornice in rilievo intorno allo specchio, stile elegante da ingresso o camera",
    doghe: "boiserie a doghe verticali in legno: listelli verticali stretti e ravvicinati (profilo squadrato tipo listone, non arrotondato), accostati l'uno all'altro dal pavimento al soffitto con una sottile fuga d'ombra tra una doga e l'altra, superficie calda e materica con venatura del legno naturale, stile contemporaneo caldo",
    pannello: "boiserie a pannello semplice: 2-4 pannelli rettangolari LARGHI (proporzione orizzontale, MAI quadrati, MAI una fitta griglia di tanti riquadri piccoli tipo scacchiera) per ogni parete inquadrata, ciascuno largo almeno il doppio della sua altezza, incorniciati da una modanatura sottile e lineare (profilo semplice, NON bugnato, NON scolpito, niente cornici multilivello elaborate), superficie interna liscia, geometria essenziale e minimale, ombre leggere e nette solo lungo il bordo della cornice"
  };
  const boiserieDesc = BOISERIE_STYLE_DESC[boiserieStyle] || BOISERIE_STYLE_DESC.specchiatura;
  // Esterni Imbiancatura: il cliente sceglie la granulometria del prodotto.
  const GRANA_TEXTURE = {
    fine: "tinteggiatura per esterni a grana fine: superficie opaca leggermente ruvida, con granelli minerali piccoli (circa 0,5-1 mm) fitti e distribuiti in modo irregolare su tutta la facciata, micro-rilievo tattile visibile da vicino con piccole ombre tra i granelli, aspetto di pittura al quarzo; NON liscia e NON lucida",
    grossa: "rasatura/rivestimento a spessore per esterni a grana grossa: superficie opaca e marcatamente ruvida, granelli minerali grandi (circa 1,5-2 mm) fitti e irregolari con piccoli pori tra loro, rilievo tridimensionale ben visibile con ombre nette tra i granelli, aspetto di intonachino/rivestimento rustico reale; NON liscia"
  };
  const isGranaStyled = materialId === "imbiancatura" && context === "esterno" && GRANA_TEXTURE[grana];
  // SPC: nel catalogo Rendrum i colori SPC sono tutti effetto LEGNO (doghe);
  // solo la posa "dritta" è in piastroni effetto pietra/cemento.
  if (materialId === "spc") {
    const SPC_LINES = {
      bloom: "pavimento SPC Quick-Step Alpha Vinyl collezione Bloom: DOGHE EFFETTO LEGNO di 20,9 cm di larghezza e 149,4 cm di lunghezza, stampa legno ad alta definizione con venature ben visibili nel colore indicato, microbisello su tutti i lati che rende visibile ogni singola doga, superficie opaca-satinata con leggera goffratura a registro",
      blos: "pavimento SPC Quick-Step Alpha Vinyl collezione Blos: DOGHE EFFETTO LEGNO di 18,9 cm di larghezza e 125,1 cm di lunghezza, stampa legno ad alta definizione con venature ben visibili nel colore indicato, microbisello su tutti i lati che rende visibile ogni singola doga, superficie opaca-satinata",
      ciro: "pavimento SPC Quick-Step Alpha Vinyl collezione Ciro: LISTELLI EFFETTO LEGNO di 12,6 × 63 cm posati A SPINA DI PESCE CLASSICA, stampa legno con venature visibili nel colore indicato, microbisello su tutti i lati, superficie opaca-satinata",
      illume: "pavimento SPC Quick-Step Alpha Vinyl collezione Illume: PIASTRE rettangolari di 42,8 × 85,6 cm con stampa EFFETTO CEMENTO/pietra morbida e leggermente nuvolata nel colore indicato, microbisello su tutti i lati che rende visibile ogni piastra, superficie opaca, senza fughe stuccate",
    };
    const lineDesc = SPC_LINES[spcLine] || SPC_LINES.bloom;
    MATERIAL_TEXTURE.spc = lineDesc + "; deve essere chiaramente riconoscibile " + (spcLine === "illume" ? "come pavimento a piastre" : "come pavimento in legno a doghe anche se il colore è molto scuro, NON un pavimento uniforme, NON piastrelle, NON resina o cemento") + ", posato su tutto il pavimento";
  }
  const baseTextureDesc = materialId === "decorazioni"
    ? boiserieDesc
    : isGranaStyled
      ? GRANA_TEXTURE[grana]
      : (MATERIAL_TEXTURE[materialId] || `una finitura in ${material}`);
  const effettoAddon = (EFFETTO_MATERIALS.includes(materialId) && EFFETTO_TEXTURE[effetto]) ? EFFETTO_TEXTURE[effetto] : "";
  const PARQUET_POSA_DESC = {
    cassero_regolare: "posa a cassero regolare: tavole lunghe in file parallele, con i giunti di testa sfalsati a passo costante (ogni fila spostata di metà tavola rispetto alla precedente)",
    cassero_irregolare: "posa a cassero irregolare (a correre): tavole in file parallele con i giunti di testa sfalsati in modo casuale, lunghezze delle tavole variabili",
    spina_pesce: "posa a SPINA DI PESCE CLASSICA (herringbone): listelli rettangolari corti (proporzione circa 1:5) con le teste tagliate DRITTE a 90°; ogni listello è perpendicolare al vicino e la sua TESTA appoggia contro il FIANCO LUNGO del listello accanto, formando una scaletta a zig-zag a gradini. ATTENZIONE: NON è la spina ungherese/chevron: NON devono esserci tagli a 45°, NON devono esserci punte a freccia e NON deve esserci una linea di giunzione dritta e continua al centro delle file; le giunzioni tra le file sono a gradini sfalsati",
    spina_ungherese: "posa a SPINA UNGHERESE (chevron): listelli con le teste tagliate a 45° (parallelogrammi), accostati testa contro testa in modo da formare file di frecce a V continue tutte nella stessa direzione, con le punte allineate lungo linee di giunzione dritte e continue; NON è la spina di pesce classica a gradini",
    quadri: "posa a quadri (mosaico/dama): quadrotti formati da gruppi di listelli paralleli, con la direzione dei listelli alternata di 90° da un quadrotto all'altro come una scacchiera",
    cassero: "posa a cassero (a correre): doghe lunghe parallele con i giunti di testa sfalsati in modo naturale",
    correre: "posa a correre (tolda di nave): doghe lunghe parallele con i giunti di testa sfalsati in modo naturale e casuale, mai allineati tra file vicine",
    sfalsata: "piastre rettangolari posate in file parallele, ogni fila sfalsata di metà lunghezza rispetto alla precedente",
    griglia: "piastre rettangolari posate a griglia con tutti i giunti allineati in entrambe le direzioni",
    dritta: "posa dritta in linea: piastrelle rettangolari grandi (circa 60x120 cm) accostate su una griglia regolare con giunti allineati in entrambe le direzioni",
    fascia_bindello: "posa con fascia e bindello: campo centrale in listelli paralleli, incorniciato lungo tutto il perimetro della stanza da una fascia di listelli posati in senso perpendicolare e da un sottile bindello (listello di bordo) che corre parallelo ai muri, con gli angoli tagliati a 45°"
  };
  const posaAddon = ((materialId === "parquet" || materialId === "spc") && PARQUET_POSA_DESC[parquetPosa])
    ? `. SCHEMA DI POSA OBBLIGATORIO: ${PARQUET_POSA_DESC[parquetPosa]}; il disegno della posa deve essere chiaramente riconoscibile su tutto il pavimento e seguire la prospettiva della stanza, e la superficie ha il colore indicato${materialId === "spc" ? " con la stampa decorativa realistica (venature del legno oppure disegno di pietra, cemento o marmo)" : " con venature naturali"}`
    : "";
  const textureDesc = baseTextureDesc + effettoAddon + posaAddon;

  // Monolith Pietra e Terrazzo si posano SOLO a pavimento (non a parete): lo
  // diciamo esplicitamente all'AI così non applica la lavorazione anche ai muri
  // inquadrati nella foto.
  const FLOOR_ONLY_MATERIALS = ["monolith_pietra", "monolith_terrazzo", "parquet", "spc", "piastrelle", "graniglia_esterni"];
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
  const resinaAreaDesc = (materialId && (materialId.indexOf("monolith") === 0 || materialId === "microcemento") && resinaArea && RESINA_AREA_DESC[resinaArea])
    ? RESINA_AREA_DESC[resinaArea]
    : null;

  const surfaceDesc = isFloorOnly
    ? "SOLO al pavimento inquadrato (questa lavorazione si posa esclusivamente a pavimento, non va applicata alle pareti anche se visibili nella foto)"
    : (resinaAreaDesc || ((materialId === "imbiancatura" && context === "esterno") ? "a tutte le pareti esterne della facciata visibili nella foto" : "alla superficie del pavimento/parete inquadrata"));

  // Layout principale facciata (solo Imbiancatura Esterno): "due_colori" divide
  // semplicemente la facciata in parte alta e parte bassa. Il marcapiano
  // (striscia sottile che separa le due zone) e le righe decorative sono note
  // aggiuntive indipendenti, definite più sotto come i davanzali/balconi/ecc.
  const FACADE_LAYOUT_DESC = {
    due_colori: `Dividi la facciata in due parti orizzontali sovrapposte: (1) la parte alta = la METÀ SUPERIORE dell'altezza della facciata, dalla linea di gronda fino ESATTAMENTE a metà altezza, nel colore ${colorRef(colorA, colorAHex)}; (2) la parte bassa = la METÀ INFERIORE della facciata, da metà altezza fino a terra, nel colore ${colorRef(colorB, colorBHex)}. La linea di divisione va a metà altezza della facciata (misurata dalla gronda a terra): la parte bassa deve occupare il 50% dell'altezza, MAI meno. Non abbassare la divisione fino al solaio del piano terra o alla linea delle finestre del piano terra. ATTENZIONE: il colore della parte bassa deve riempire TUTTA quella porzione di facciata (comprese le zone intorno a porte e finestre del piano terra), non solo una sottile striscia rasoterra. La linea di separazione tra le due parti deve essere orizzontale, netta e ben visibile.`
  };
  const isFacadeStyled = materialId === "imbiancatura" && context === "esterno" && facadeLayout === "due_colori" && colorB;

  // Davanzali finestre in un colore diverso dalla facciata: opzione indipendente
  // dal layout scelto (un colore/due colori), disponibile solo per Imbiancatura
  // Esterno. Nota descrittiva separata, aggiunta al prompt solo quando il
  // cliente ha attivato il toggle e scelto davvero un colore.
  const isDavanzaliStyled = materialId === "imbiancatura" && context === "esterno" && addDavanzali && colorDavanzali;
  const davanzaliNote = isDavanzaliStyled
    ? ` Inoltre, dipingi TUTTI i davanzali delle finestre visibili nella foto nel colore ${colorRef(colorDavanzali, colorDavanzaliHex)}: il davanzale è la sporgenza orizzontale sotto ogni finestra. Applica questo colore SOLO ai davanzali, non al resto dell'infisso/telaio della finestra né ai vetri, che restano invariati.`
    : "";

  // Marcapiano: striscia orizzontale sottile (5-10cm) di un colore diverso.
  // Opzione indipendente, disponibile sia con la facciata a "due colori"
  // (la striscia va sulla linea dove la facciata cambia colore) sia con "un
  // colore" (la striscia va a un'altezza naturale della facciata, es. tra
  // piano terra e primo piano, con la facciata dello stesso colore sopra e
  // sotto di essa).
  const isMarcapianoStyled = materialId === "imbiancatura" && context === "esterno" && addMarcapiano && colorC;
  const marcapianoNote = isMarcapianoStyled
    ? (facadeLayout === "due_colori" && colorB
      ? ` Inoltre, disegna una striscia orizzontale sottile (alta circa 5-10cm), il "marcapiano", nel colore ${colorRef(colorC, colorCHex)}, esattamente sulla linea dove la facciata passa dal colore della parte alta al colore della parte bassa: la striscia deve essere ben visibile e nettamente distinta dai colori della facciata sopra e sotto di essa, come nelle classiche palazzine italiane.`
      : ` Inoltre, disegna una striscia orizzontale sottile (alta circa 5-10cm), il "marcapiano", nel colore ${colorRef(colorC, colorCHex)}, a un'altezza naturale della facciata (tipicamente all'altezza del solaio tra piano terra e primo piano, se riconoscibile nella foto): sopra e sotto la striscia la facciata resta dello stesso colore ${colorRef(colorA, colorAHex)}. La striscia deve essere ben visibile e nettamente distinta dal resto della facciata, come nelle classiche palazzine italiane.`)
    : "";

  // Sottotetto/sporto di gronda (in legno o intonacato/cemento) in un colore
  // diverso dalla facciata: opzione indipendente, disponibile solo per
  // Imbiancatura Esterno, come i davanzali. Applica il colore SOLO alla parte
  // sotto la falda del tetto (che sia legno a vista o intonaco/cemento), non
  // al manto di copertura (tegole) né al resto della facciata.
  const isSottotettoStyled = materialId === "imbiancatura" && context === "esterno" && addSottotetto && colorSottotetto;
  const sottotettoNote = isSottotettoStyled
    ? ` Inoltre, dipingi TUTTO il sottotetto/sporto di gronda visibile nella foto (la parte sotto la falda del tetto, sia essa in legno a vista con travetti/assito, sia intonacata/cementizia) nel colore ${colorRef(colorSottotetto, colorSottotettoHex)}. Applica questo colore SOLO al sottotetto/gronda, non al manto di copertura del tetto (tegole/coppi) né al resto della facciata.`
    : "";

  // Tetto: il manto di copertura ripulito e ricolorato (guaina, lamiera,
  // tegole in cemento). Solo Imbiancatura Esterno, opzione indipendente.
  const isTettoStyled = materialId === "imbiancatura" && context === "esterno" && addTetto && colorTetto;
  const tettoNote = isTettoStyled
    ? ` Inoltre, rinnova TUTTO il manto di copertura del tetto visibile nella foto nel colore ${colorRef(colorTetto, colorTettoHex)}: il tetto deve apparire pulito e in ordine, senza muschio, macchie, ruggine, lamiere rotte o elementi mancanti, mantenendo la stessa forma, la stessa pendenza e lo stesso disegno delle tegole/lastre. Comignolo, grondaie e pluviali restano come sono, solo puliti.`
    : "";

  // Imbiancatura interni: soffitto (plafone) ed effetto scatola.
  const isInterniPittura = materialId === "imbiancatura" && context !== "esterno";
  const plafoneNote = !isInterniPittura ? ""
    : effettoScatola
      ? ` EFFETTO SCATOLA: dipingi pareti E soffitto nello stesso identico colore ${colorRef(colorA, colorAHex)}, senza stacchi tra parete e soffitto, compresi eventuali travi, cornici e sporgenze del soffitto: l'ambiente deve risultare avvolgente e continuo, tutto in un unico colore. Porte, finestre, mobili e pavimento restano come sono.`
      : colorPlafone
        ? ` Dipingi il soffitto (plafone) nel colore ${colorRef(colorPlafone, colorPlafoneHex)}, con uno stacco netto e pulito sulla linea tra pareti e soffitto; le pareti restano nel loro colore indicato sopra.`
        : " Il soffitto NON va dipinto: resta esattamente com'è nella foto, cambia solo il colore delle pareti.";

  // Cornici di porte e finestre: le fasce in rilievo intorno alle aperture
  // (cornici, archi, spallette, imbotti) in un colore diverso dalla facciata.
  const isCorniciStyled = materialId === "imbiancatura" && context === "esterno" && addCornici && colorCornici;
  const corniciNote = isCorniciStyled
    ? ` Inoltre, dipingi TUTTE le cornici in rilievo intorno a finestre e porte (fasce, archi, spallette e imbotti) nel colore ${colorRef(colorCornici, colorCorniciHex)}, con bordi netti e puliti. Se una finestra non ha una cornice in rilievo, non inventarla: colora solo quelle che esistono. Non colorare vetri, telai, persiane, porte e davanzali.`
    : "";

  // Balconi (parapetti/ringhiere) in un colore diverso dalla facciata: opzione
  // indipendente, disponibile solo per Imbiancatura Esterno, come davanzali e
  // sottotetto. Applica il colore SOLO ai parapetti/ringhiere dei balconi, non
  // al resto della facciata né ai pavimenti dei balconi stessi.
  const isBalconiStyled = materialId === "imbiancatura" && context === "esterno" && addBalconi && colorBalconi;
  const balconiNote = isBalconiStyled
    ? ` Inoltre, dipingi TUTTI i parapetti/ringhiere dei balconi visibili nella foto nel colore ${colorRef(colorBalconi, colorBalconiHex)}. Applica questo colore SOLO ai parapetti/ringhiere dei balconi, non al resto della facciata né al pavimento dei balconi.`
    : "";

  // Serramenti (finestre/porte esterne in legno) in un colore diverso dalla
  // facciata: opzione indipendente, disponibile solo per Imbiancatura Esterno,
  // come davanzali/sottotetto/balconi. Applica il colore SOLO ai telai/ante
  // degli infissi (finestre e porte esterne), non ai davanzali, ai vetri né al
  // resto della facciata.
  const isSerramentiStyled = materialId === "imbiancatura" && context === "esterno" && addSerramenti && colorSerramenti;
  const serramentiNote = isSerramentiStyled
    ? ` Inoltre, dipingi OBBLIGATORIAMENTE TUTTI i serramenti visibili nella foto nel colore ${colorRef(colorSerramenti, colorSerramentiHex)}: telai delle finestre, persiane, scuri, ante a battente, tapparelle e porte/portefinestre esterne. Il loro colore originale (es. marrone/legno) NON deve restare da nessuna parte: nel risultato devono essere tutti di questo colore. Non colorare i vetri, i davanzali e il resto della facciata.`
    : "";

  // Righe decorative: bande alternate (verticali o orizzontali) applicate solo
  // a una parte della facciata (l'altra resta a tinta unita col colore già
  // assegnato a quella zona). Opzione indipendente dal layout principale,
  // disponibile solo per Imbiancatura Esterno.
  const isRigheStyled = materialId === "imbiancatura" && context === "esterno" && addRighe && colorRighe;
  const twoColorFacade = facadeLayout === "due_colori" && colorB;
  // Colore di base della zona in cui vanno le righe: le bande alternano
  // SEMPRE questi due colori espliciti, mai "il colore già presente".
  const righeZonaEff = righeOrientamento === "verticali" ? (righeZona === "alta" ? "alta" : "bassa") : (righeExtent === "tutta" ? "tutta" : "bassa");
  const zoneBase = (z) => (z === "bassa" && twoColorFacade) ? [colorB, colorBHex] : [colorA, colorAHex];
  const thin = righeSpessore !== "larghe";
  // Misure delle strisce "larghe": striscia più stretta del fondo, così il
  // fondo resta il colore dominante e l'effetto non si legge al contrario.
  const STRIPE_CM = 25, GAP_CM = 50;
  const stripesInM = (m) => Math.floor((m * 100) / (STRIPE_CM + GAP_CM));
  // Righe orizzontali su una zona: dal punto "start" verso il basso,
  // SEMPRE prima GAP_CM di fondo, poi STRIPE_CM di striscia, e così via.
  const hStripes = (base, start, heightM, end = "terra") => thin
    ? `questa zona ha come FONDO il colore ${colorRef(base[0], base[1])}: sul fondo disegna righe orizzontali SOTTILI (spessore circa 5-8 cm, come una linea decorativa) nel colore ${colorRef(colorRighe, colorRigheHex)}, distanziate in modo regolare (circa 50 cm tra una riga e l'altra), partendo ${start.replace(/^la /, "dalla ")} verso il basso con 50 cm di fondo prima della prima riga. Tra una riga e l'altra il muro resta nel colore di fondo ${base[0]}. Le righe sono linee strette, NON fasce larghe`
    : `questa zona ha come FONDO il colore ${colorRef(base[0], base[1])}: prima dipingi tutta la zona nel colore di fondo ${base[0]}, poi SOVRAPPONI sopra il fondo le strisce nel colore ${colorRef(colorRighe, colorRigheHex)}. MISURE REALI: la zona è alta circa ${heightM},00 m. Partendo ${start.replace(/^la /, "dalla ")} verso il basso la sequenza è: ${GAP_CM} cm di fondo ${base[0]}, poi ${STRIPE_CM} cm di striscia ${colorRighe}, poi ${GAP_CM} cm di fondo, poi ${STRIPE_CM} cm di striscia, e così via fino a ${end}: in totale ${stripesInM(heightM)} strisce ${colorRighe} alte ${STRIPE_CM} cm ciascuna, tutte uguali, separate da ${GAP_CM} cm di fondo. Le strisce sono più STRETTE del fondo (circa la metà): il fondo ${base[0]} deve restare chiaramente il colore dominante della zona. Subito sotto ${start} c'è SEMPRE il fondo ${base[0]}, mai una striscia. Usa porte e finestre come riferimento di scala (una porta è alta circa 2,10 m) per rispettare queste misure in prospettiva`;
  const vStripes = (base) => thin
    ? `questa zona ha come FONDO il colore ${colorRef(base[0], base[1])}: sul fondo disegna righe verticali SOTTILI (larghe circa 5-8 cm) nel colore ${colorRef(colorRighe, colorRigheHex)}, distanziate in modo regolare di circa 50 cm, partendo dallo spigolo della facciata con 50 cm di fondo. Le righe sono linee strette, NON fasce larghe`
    : `questa zona ha come FONDO il colore ${colorRef(base[0], base[1])}: prima dipingi tutta la zona nel colore di fondo, poi SOVRAPPONI sopra il fondo strisce verticali nel colore ${colorRef(colorRighe, colorRigheHex)} larghe ${STRIPE_CM} cm, separate da ${GAP_CM} cm di fondo ${base[0]}, partendo dallo spigolo della facciata con ${GAP_CM} cm di fondo; il fondo resta il colore dominante (usa porte e finestre come riferimento di scala: una porta è larga circa 90 cm)`;
  const MID_TWO = "la linea di metà casa (il cambio di colore tra parte alta e parte bassa)";
  const MID_ONE = "la metà altezza della facciata (una linea immaginaria: lì il colore NON cambia, cominciano solo le strisce)";
  const GRONDA = "la linea di gronda/sottotetto";
  const sameAsUpper = twoColorFacade && righeZonaEff === "bassa" && String(colorA).trim().toUpperCase() === String(colorRighe).trim().toUpperCase()
    ? ` Il colore delle righe (${colorRighe}) è la STESSA IDENTICA tinta della parte alta della facciata: le righe devono risultare esattamente dello stesso colore della parte alta, non un'altra tonalità.`
    : "";
  let righeNote = "";
  if (isRigheStyled) {
    const A = [colorA, colorAHex], B = twoColorFacade ? [colorB, colorBHex] : A;
    if (righeOrientamento === "verticali") {
      const alta = righeZonaEff === "alta";
      righeNote = ` Inoltre, nella ${alta ? "metà alta" : "metà bassa"} della facciata (${alta ? "dalla gronda fino a metà altezza" : "da metà altezza fino a terra"}), ${vStripes(alta ? A : B)}. Non usare nessun terzo colore. L'altra metà della facciata resta a tinta unita nel suo colore, senza strisce.`;
    } else if (righeZonaEff === "tutta") {
      righeNote = twoColorFacade
        ? ` Inoltre, le strisce orizzontali coprono TUTTA la facciata. Nella parte alta (dalla gronda fino a metà casa, circa 3,00 m) ${hStripes(A, GRONDA, 3, "la linea di metà casa")}. Nella parte bassa (da metà casa fino a terra, circa 3,00 m) ${hStripes(B, MID_TWO, 3)}. Non usare nessun terzo colore.`
        : ` Inoltre, le strisce orizzontali coprono TUTTA la facciata, dalla gronda fino a terra (circa 6,00 m, due piani): ${hStripes(A, GRONDA, 6)}. Non usare nessun terzo colore.`;
    } else {
      righeNote = twoColorFacade
        ? ` Inoltre, nella parte bassa della facciata (da metà casa fino a terra, circa 3,00 m), ${hStripes(B, MID_TWO, 3)}. Non usare nessun terzo colore e nessuna tonalità intermedia.${sameAsUpper} La parte alta della facciata resta a tinta unita nel suo colore, senza strisce.`
        : ` Inoltre, la facciata è tutta di un unico colore ${colorRef(colorA, colorAHex)}, ma le strisce vanno SOLO nella metà bassa (da metà altezza fino a terra, circa 3,00 m): ${hStripes(A, MID_ONE, 3)}. La metà alta della facciata resta a tinta unita ${colorA}, SENZA strisce. Non usare nessun terzo colore.`;
    }
  }

  // Graniglia per Esterni con bordo bicolore: campo principale in un colore e una
  // fascia/bordo perimetrale in un colore diverso, che segue il perimetro della
  // superficie (contro i muri/bordi) come nelle pose reali fotografate dal cliente
  // (terrazzi con bordo scuro, vialetti con bordo chiaro laterale).
  const isGranigliaBordo = materialId === "graniglia_esterni" && granigliaLayout === "bordo" && colorB;
  const granigliaBordoDesc = isGranigliaBordo
    ? `Applica il colore ${colorRef(colorA, colorAHex)} al campo principale della superficie (la parte centrale), e il colore ${colorRef(colorB, colorBHex)} a una fascia/bordo perimetrale ben distinta che segue il contorno della superficie (lungo i muri, i bordi della piscina o i lati del vialetto), larga circa 20-30cm, con una linea di separazione netta e regolare tra campo e bordo, esattamente come nelle pose professionali reali di pavimentazioni decorative in graniglia.`
    : null;

  // Il Corten ha un colore intrinseco (base ocra/ruggine dell'acciaio ossidato,
  // già descritto in EFFETTO_TEXTURE.corten): il cliente non sceglie un colore
  // per questo effetto, quindi il colore non entra nella descrizione — solo la
  // texture/pattern Corten, aggiunta separatamente più sotto via effettoAddon.
  const isCortenStyled = EFFETTO_MATERIALS.includes(materialId) && effetto === "corten";

  // Costruzione del prompt descrittivo per il modello di editing immagine.
  const colorDesc = isCortenStyled
    ? "il colore naturale ocra/ruggine dell'effetto Corten (la texture stessa definisce già la tonalità, non è un colore scelto a parte)"
    : isFacadeStyled
      ? FACADE_LAYOUT_DESC[facadeLayout]
      : isGranigliaBordo
        ? granigliaBordoDesc
        : (colorB && materialId === "monolith_marmo"
          ? `un marmo bicolore: fondo nel colore ${colorRef(colorA, colorAHex)} con venature marmoree naturali ben visibili nel colore ${colorRef(colorB, colorBHex)}`
          : colorB
          ? `un effetto nuvolato che miscela il colore ${colorRef(colorA, colorAHex)} con il colore ${colorRef(colorB, colorBHex)}`
          : `il colore uniforme ${colorRef(colorA, colorAHex)}`);

  const sceneDesc = (materialId === "imbiancatura" && context === "esterno")
    ? "questa foto reale della facciata esterna di un edificio"
    : (materialId === "graniglia_esterni")
      ? "questa foto reale di uno spazio esterno (terrazzo, vialetto, giardino, bordo piscina o rampa garage)"
      : "questa foto reale di un ambiente domestico";

  // La boiserie, più di un semplice colore/texture piatta, è un elemento architettonico
  // con vero spessore fisico: senza istruzioni extra l'AI tende a "incollarla" sopra la
  // foto come un adesivo piatto invece di integrarla nella scena (prospettiva, luce,
  // ombre, mobili davanti). Questa nota extra spinge verso un risultato più fotografico
  // e meno da rendering 3D.
  const boiserieRealismNote = materialId === "decorazioni"
    ? " La boiserie deve avere volume e spessore reali, non un'immagine piatta incollata sopra la foto: segui esattamente la prospettiva e le linee di fuga della parete originale, fai cadere le ombre delle cornici/modanature/scanalature nella stessa direzione della luce già presente nella stanza, usa una texture di legno naturale con leggere variazioni di tono (mai un colore piatto e uniforme), e lascia che mobili/oggetti già presenti nella foto restino davanti alla boiserie dove la coprirebbero nella realtà. IMPORTANTE: se nella foto sono presenti porte, finestre, prese elettriche, interruttori o altri elementi già esistenti, NON coprirli né trasformarli in pannellatura: devono restare riconoscibili esattamente come nella foto originale, e la boiserie va applicata solo all'area di parete libera intorno a loro. Il risultato finale deve sembrare una vera fotografia di una posa reale, non un rendering 3D né un adesivo digitale."
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
  // Per il Corten il colore non è scelto dal cliente (vedi isCortenStyled sopra),
  // quindi anche se arrivasse un colorAHex residuo non lo trattiamo come vincolo
  // esatto da rispettare: il Corten segue solo la sua texture/pattern.
  const hasAnyHex = !isCortenStyled && Boolean(colorAHex || colorBHex || colorCHex || colorDavanzaliHex || colorSottotettoHex || colorPlafoneHex || colorTettoHex || colorCorniciHex || colorBalconiHex || colorSerramentiHex || colorRigheHex);
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

  const isExteriorFacade = materialId === "imbiancatura" && context === "esterno";
  const keepList = ["la prospettiva", "la luce", "le ombre", "il terreno, il giardino, gli oggetti e l'ambiente circostante"];
  if (!(isTettoStyled)) keepList.splice(3, 0, "il manto di copertura del tetto (tegole/coppi)");
  if (!(isCorniciStyled)) keepList.push("le cornici di porte e finestre");
  if (!(isSerramentiStyled)) keepList.push("gli infissi, le persiane e le porte");
  if (!(isSottotettoStyled)) keepList.push("il sottotetto/sporto di gronda");
  if (!(isDavanzaliStyled)) keepList.push("i davanzali");
  if (!(isBalconiStyled)) keepList.push("i balconi/parapetti");
  const changeList = ["il colore/texture della facciata"];
  if (isRigheStyled) changeList.push("le righe decorative");
  if (isMarcapianoStyled) changeList.push("il marcapiano");
  if (isDavanzaliStyled) changeList.push("i davanzali");
  if (isSottotettoStyled) changeList.push("il sottotetto/sporto di gronda");
  if (isTettoStyled) changeList.push("il manto di copertura del tetto");
  if (isCorniciStyled) changeList.push("le cornici di porte e finestre");
  if (isSerramentiStyled) changeList.push("TUTTI i serramenti, persiane e porte esterne");
  if (isBalconiStyled) changeList.push("i balconi/parapetti");
  const facadeKeepSentence = `Mantieni identici ${keepList.join(", ")}. Devi invece modificare, in modo fotorealistico come una vera lavorazione professionale: ${changeList.join(", ")}.`;

  // Riepilogo finale: una riga per zona, così l'AI non deve ricostruire i
  // colori da istruzioni sparse (ed eventuali colori uguali su più zone sono
  // espliciti, non un errore da "correggere").
  const zones = [];
  if (isExteriorFacade) {
    if (twoColorFacade) {
      zones.push(`parte alta della facciata = ${colorRef(colorA, colorAHex)}`);
      zones.push(`parte bassa della facciata = ${colorRef(colorB, colorBHex)}${isRigheStyled && righeZonaEff !== "alta" ? ` come FONDO, con ${thin ? "righe sottili" : `strisce da ${STRIPE_CM} cm alternate a ${GAP_CM} cm di fondo, partendo dalla linea di metà casa con ${GAP_CM} cm di fondo,`} ${righeOrientamento === "verticali" ? "verticali" : "orizzontali"} nel colore ${colorRighe} sovrapposte al fondo (fondo e strisce NON invertiti)` : ""}`);
      if (isRigheStyled && righeZonaEff !== "bassa") zones[0] += ` con ${thin ? "righe sottili" : "bande larghe"} ${righeOrientamento === "verticali" ? "verticali" : "orizzontali"} nel colore ${colorRighe}`;
    } else {
      const whereStripes = righeOrientamento === "verticali" ? (righeZonaEff === "alta" ? "verticali nella metà alta" : "verticali nella metà bassa") : (righeZonaEff === "tutta" ? "orizzontali su tutta l'altezza" : "orizzontali SOLO nella metà bassa");
      zones.push(`facciata tutta = ${colorRef(colorA, colorAHex)}${isRigheStyled ? ` come fondo, con ${thin ? "righe sottili" : `strisce da ${STRIPE_CM} cm alternate a ${GAP_CM} cm di fondo`} ${whereStripes} nel colore ${colorRighe}` : ""}`);
    }
    if (isMarcapianoStyled) zones.push(`marcapiano = ${colorRef(colorC, colorCHex)}`);
    else if (twoColorFacade) zones.push("tra parte alta e parte bassa NESSUNA fascia o cornice di un terzo colore: solo il cambio netto di colore");
    if (isDavanzaliStyled) zones.push(`davanzali = ${colorRef(colorDavanzali, colorDavanzaliHex)}`);
    if (isSottotettoStyled) zones.push(`sottotetto/sporto di gronda (travetti e assito compresi) = ${colorRef(colorSottotetto, colorSottotettoHex)}`);
    if (isTettoStyled) zones.push(`manto di copertura del tetto (pulito e rinnovato) = ${colorRef(colorTetto, colorTettoHex)}`);
    if (isCorniciStyled) zones.push(`cornici in rilievo di porte e finestre (archi e spallette compresi) = ${colorRef(colorCornici, colorCorniciHex)}`);
    if (isSerramentiStyled) zones.push(`serramenti, persiane, scuri e porte esterne = ${colorRef(colorSerramenti, colorSerramentiHex)}`);
    if (isBalconiStyled) zones.push(`balconi/parapetti = ${colorRef(colorBalconi, colorBalconiHex)}`);
  }
  const zonesSummary = zones.length > 1
    ? ` RIEPILOGO VINCOLANTE, ZONA PER ZONA (ogni riga va rispettata; se lo stesso colore compare in più zone è voluto, non cambiarlo): ${zones.map((z, i) => `(${i + 1}) ${z}`).join("; ")}. Prima di restituire l'immagine controlla che ognuna di queste zone abbia esattamente il colore indicato.`
    : "";
  const exteriorPreservationNote = " REGOLA ASSOLUTA: non spostare, aggiungere o rimuovere nessun elemento della foto e non cambiare inquadratura o prospettiva. Tutto ciò che non è elencato nelle istruzioni resta identico all'originale; tutto ciò che è elencato (vedi riepilogo) va modificato OBBLIGATORIAMENTE, anche se si tratta di serramenti, persiane, porte, cornici, sottotetto o tetto.";

  const posaRefClean = (typeof posaRefImage === "string" && posaRefImage.length < 1_500_000 && (materialId === "parquet" || materialId === "spc"))
    ? posaRefImage.replace(/^data:image\/\w+;base64,/, "")
    : null;
  const posaRefNote = posaRefClean
    ? " SCHEMA DI POSA DI RIFERIMENTO: ti sono state fornite DUE immagini. La PRIMA è la foto reale da modificare. La SECONDA è lo schema del pavimento visto DALL'ALTO, disegnato con la disposizione ESATTA dei listelli: copia fedelmente quella geometria (forma dei listelli, tagli delle teste, modo in cui si incastrano e direzione delle file) sul pavimento della prima foto, in prospettiva e alla scala giusta per la stanza (listelli di dimensioni reali). Dalla seconda immagine prendi SOLO la geometria della posa: luce, ombre e resto della stanza vengono dalla prima foto."
    : "";
  const colorCardClean = (typeof colorCardImage === "string" && colorCardImage.length < 2_000_000)
    ? colorCardImage.replace(/^data:image\/\w+;base64,/, "")
    : null;
  const colorCardNote = colorCardClean
    ? " CARTELLA COLORI: ti sono state fornite DUE immagini. La PRIMA è la foto reale da modificare. La SECONDA è la cartella colori ufficiale: a sinistra ogni riquadro pieno mostra il colore ESATTO da usare per la zona scritta accanto (es. PARTE ALTA FACCIATA, PARTE BASSA FACCIATA, RIGHE, SOTTOTETTO, TETTO, CORNICI PORTE E FINESTRE, SERRAMENTI E PERSIANE); a destra c'è lo SCHEMA DELLA FACCIATA, un disegno semplificato che mostra dove va ogni colore e con quali proporzioni (altezza della divisione, fondo e strisce, larghezza delle strisce rispetto al fondo). Segui quello schema per la disposizione dei colori sulla facciata vera della foto, adattandolo alla sua prospettiva. Riproduci quelle tinte il più fedelmente possibile (luminosità e tonalità), zona per zona: se un colore è un grigio medio deve restare un grigio medio, non schiarirlo né scurirlo. La cartella colori serve SOLO come riferimento: NON inserirla, NON copiarla e NON scrivere testo nell'immagine finale."
    : "";

  // SECONDO PASSAGGIO (solo quando ci sono le righe): la foto arriva già
  // tinteggiata dal primo passaggio; qui l'AI deve fare UNA sola cosa,
  // aggiungere le strisce, senza toccare nient'altro.
  const isRigheStep = step === "righe" && isRigheStyled;
  const righeZoneName = righeOrientamento === "verticali"
    ? (righeZonaEff === "alta" ? "sulla parte alta della facciata" : "sulla parte bassa della facciata")
    : (righeZonaEff === "tutta" ? "su tutta la facciata" : "sulla parte bassa della facciata");
  const righeStepPrompt = [
    "Questa è una foto di una facciata esterna GIÀ TINTEGGIATA: i colori sono già corretti e NON vanno cambiati.",
    twoColorFacade ? `La facciata è già divisa a metà altezza: parte alta nel colore ${colorRef(colorA, colorAHex)} e parte bassa nel colore ${colorRef(colorB, colorBHex)}. Il confine già visibile tra le due è la LINEA DI METÀ CASA.` : `La facciata è già tinteggiata nel colore ${colorRef(colorA, colorAHex)}.`,
    `UNICO COMPITO: aggiungi le strisce decorative ${righeZoneName}.${righeNote}`,
    "Le strisce sono pittura sul muro: seguono la prospettiva della facciata, restano dietro a grondaie, pluviali, lampade, persiane e oggetti davanti al muro, e non coprono porte, finestre, vetri e serramenti.",
    colorCardNote,
    "REGOLA ASSOLUTA: a parte le strisce, l'immagine deve restare IDENTICA a quella ricevuta: stessi colori della parte alta e della parte bassa, stesso sottotetto, stessi serramenti, stessa luce, stessa inquadratura. Non ridipingere e non schiarire o scurire nessuna zona."
  ].filter(Boolean).join(" ");

  const prompt = isRigheStep ? righeStepPrompt : [
    `Modifica ${sceneDesc}.`,
    `Applica ${surfaceDesc} la seguente lavorazione: ${textureDesc}.`,
    isFacadeStyled ? colorDesc : `Il colore/tonalità da usare è ${colorDesc}.`,
    finitura ? `Finitura superficiale ${finitura} (${finitura === "lucido" ? "molto riflettente" : finitura === "opaco" ? "senza riflessi" : "leggermente satinata"}).` : "",
    isExteriorFacade
      ? facadeKeepSentence
      : isFloorOnly
        ? `Mantieni identiche la prospettiva, la luce, le ombre, i mobili, e mantieni assolutamente INVARIATE tutte le pareti/muri della stanza (colore e materiale originali): cambia solo il pavimento, in modo fotorealistico, come se fosse una vera posa professionale.`
        : `Mantieni identica la prospettiva, la luce, le ombre, i mobili e tutto il resto della stanza: cambia solo il materiale/colore/texture della superficie indicata, in modo fotorealistico, come se fosse una vera posa professionale.`,
    boiserieRealismNote,
    pannelloHeightNote,
    davanzaliNote,
    marcapianoNote,
    sottotettoNote,
    plafoneNote,
    tettoNote,
    corniciNote,
    serramentiNote,
    balconiNote,
    righeNote,
    boiserieStyleRefNote,
    posaRefNote,
    zonesSummary,
    colorCardNote,
    colorFidelityNote,
    isExteriorFacade ? exteriorPreservationNote : globalPreservationNote,
    paddedBands ? "NOTA SUL FORMATO: ai bordi della foto ci sono bande sfocate aggiunte solo per adattare il formato: lasciale come sono e NON ingrandire, spostare o ritagliare la foto al centro, che deve restare esattamente nella stessa posizione e dimensione." : ""
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

  if (provider === "openai") {
    const model = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst").trim();
    const quality = (process.env.OPENAI_IMAGE_QUALITY || "max").trim();
    const ext = (m) => (m.includes("png") ? "png" : m.includes("webp") ? "webp" : "jpg");
    // Stesso ordine delle immagini descritto nel prompt: 1) foto del cliente,
    // 2) cartella colori (o riferimento boiserie).
    const images = [{ b64: imageBase64, mime: mimeType || "image/jpeg" }];
    if (colorCardClean) images.push({ b64: colorCardClean, mime: "image/png" });
    if (boiserieStyleRefImageClean) images.push({ b64: boiserieStyleRefImageClean, mime: "image/jpeg" });
    if (posaRefClean) images.push({ b64: posaRefClean, mime: "image/jpeg" });
    const send = (extra) => {
      const fd = new FormData();
      fd.append("model", model);
      fd.append("prompt", prompt);
      fd.append("n", "1");
      images.forEach((im, i) => fd.append("image[]", new Blob([Buffer.from(im.b64, "base64")], { type: im.mime }), `immagine${i + 1}.${ext(im.mime)}`));
      Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
      return fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}` },
        body: fd
      });
    };
    // Se la connessione con OpenAI cade ("fetch failed"), riproviamo una volta.
    const sendRetry = async (extra) => {
      try { return await send(extra); }
      catch (e) { console.error("openai fetch, riprovo", e && e.cause || e); await new Promise(r => setTimeout(r, 1500)); return send(extra); }
    };
    try {
      let outMime = "image/jpeg";
      let r = await sendRetry({ quality, input_fidelity: "high", size: "auto", output_format: "jpeg" });
      let txt = await r.text();
      // Se un parametro opzionale non è accettato dal modello, riproviamo con i soli essenziali.
      if (r.status === 400 && /input_fidelity|size|output_format|quality/i.test(txt)) {
        outMime = "image/png";
        r = await sendRetry({ quality: /quality/i.test(txt) ? "high" : quality });
        txt = await r.text();
      }
      let data;
      try { data = JSON.parse(txt); } catch (e) {
        return res.status(502).json({ error: "Risposta non valida dal servizio AI (OpenAI)", details: txt.slice(0, 500) });
      }
      if (!r.ok) {
        return res.status(r.status).json({ error: "Errore dal servizio AI (OpenAI)", details: (data && data.error && data.error.message) || data });
      }
      const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
      if (!b64) return res.status(502).json({ error: "Il modello non ha restituito un'immagine", details: data });
      await countUsage();
      return res.status(200).json({ imageBase64: b64, mimeType: outMime });
    } catch (err) {
      console.error("generate-preview", err && err.cause || err); return res.status(503).json({ error: "Il servizio AI non ha risposto in tempo. Riprova tra un minuto: l'anteprima non ti è stata scalata." });
    }
  }

  let apiUrl;
  try {
    apiUrl = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent"
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
    if (colorCardClean) {
      contentParts.push({ inline_data: { mime_type: "image/png", data: colorCardClean } });
    }
    if (posaRefClean) {
      contentParts.push({ inline_data: { mime_type: "image/jpeg", data: posaRefClean } });
    }
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
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
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

    await countUsage();
    return res.status(200).json({
      imageBase64: inline.data,
      mimeType: inline.mime_type || inline.mimeType || "image/png"
    });
  } catch (err) {
    console.error("generate-preview", err && err.cause || err); return res.status(503).json({ error: "Il servizio AI non ha risposto in tempo. Riprova tra un minuto: l'anteprima non ti è stata scalata." });
  }
}
