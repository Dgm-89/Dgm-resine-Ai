// api/_geo.js — zone di lavoro (libreria, non è una funzione Vercel).
// Struttura: Paese (ISO 3166-1) -> Regione (ISO 3166-2) -> Provincia (sigla).
// Per aggiungere un nuovo Paese basta aggiungere una voce qui e nel frontend.
const GEO = {
  IT: {
    name: "Italia",
    regions: [
      { code: "IT-65", name: "Abruzzo", provinces: [["AQ", "L'Aquila"], ["CH", "Chieti"], ["PE", "Pescara"], ["TE", "Teramo"]] },
      { code: "IT-77", name: "Basilicata", provinces: [["MT", "Matera"], ["PZ", "Potenza"]] },
      { code: "IT-78", name: "Calabria", provinces: [["CZ", "Catanzaro"], ["CS", "Cosenza"], ["KR", "Crotone"], ["RC", "Reggio Calabria"], ["VV", "Vibo Valentia"]] },
      { code: "IT-72", name: "Campania", provinces: [["AV", "Avellino"], ["BN", "Benevento"], ["CE", "Caserta"], ["NA", "Napoli"], ["SA", "Salerno"]] },
      { code: "IT-45", name: "Emilia-Romagna", provinces: [["BO", "Bologna"], ["FE", "Ferrara"], ["FC", "Forlì-Cesena"], ["MO", "Modena"], ["PR", "Parma"], ["PC", "Piacenza"], ["RA", "Ravenna"], ["RE", "Reggio Emilia"], ["RN", "Rimini"]] },
      { code: "IT-36", name: "Friuli-Venezia Giulia", provinces: [["GO", "Gorizia"], ["PN", "Pordenone"], ["TS", "Trieste"], ["UD", "Udine"]] },
      { code: "IT-62", name: "Lazio", provinces: [["FR", "Frosinone"], ["LT", "Latina"], ["RI", "Rieti"], ["RM", "Roma"], ["VT", "Viterbo"]] },
      { code: "IT-42", name: "Liguria", provinces: [["GE", "Genova"], ["IM", "Imperia"], ["SP", "La Spezia"], ["SV", "Savona"]] },
      { code: "IT-25", name: "Lombardia", provinces: [["BG", "Bergamo"], ["BS", "Brescia"], ["CO", "Como"], ["CR", "Cremona"], ["LC", "Lecco"], ["LO", "Lodi"], ["MN", "Mantova"], ["MI", "Milano"], ["MB", "Monza e Brianza"], ["PV", "Pavia"], ["SO", "Sondrio"], ["VA", "Varese"]] },
      { code: "IT-57", name: "Marche", provinces: [["AN", "Ancona"], ["AP", "Ascoli Piceno"], ["FM", "Fermo"], ["MC", "Macerata"], ["PU", "Pesaro e Urbino"]] },
      { code: "IT-67", name: "Molise", provinces: [["CB", "Campobasso"], ["IS", "Isernia"]] },
      { code: "IT-21", name: "Piemonte", provinces: [["AL", "Alessandria"], ["AT", "Asti"], ["BI", "Biella"], ["CN", "Cuneo"], ["NO", "Novara"], ["TO", "Torino"], ["VB", "Verbano-Cusio-Ossola"], ["VC", "Vercelli"]] },
      { code: "IT-75", name: "Puglia", provinces: [["BA", "Bari"], ["BT", "Barletta-Andria-Trani"], ["BR", "Brindisi"], ["FG", "Foggia"], ["LE", "Lecce"], ["TA", "Taranto"]] },
      { code: "IT-88", name: "Sardegna", provinces: [["CA", "Cagliari"], ["NU", "Nuoro"], ["OR", "Oristano"], ["SS", "Sassari"], ["SU", "Sud Sardegna"]] },
      { code: "IT-82", name: "Sicilia", provinces: [["AG", "Agrigento"], ["CL", "Caltanissetta"], ["CT", "Catania"], ["EN", "Enna"], ["ME", "Messina"], ["PA", "Palermo"], ["RG", "Ragusa"], ["SR", "Siracusa"], ["TP", "Trapani"]] },
      { code: "IT-52", name: "Toscana", provinces: [["AR", "Arezzo"], ["FI", "Firenze"], ["GR", "Grosseto"], ["LI", "Livorno"], ["LU", "Lucca"], ["MS", "Massa-Carrara"], ["PI", "Pisa"], ["PT", "Pistoia"], ["PO", "Prato"], ["SI", "Siena"]] },
      { code: "IT-32", name: "Trentino-Alto Adige", provinces: [["BZ", "Bolzano"], ["TN", "Trento"]] },
      { code: "IT-55", name: "Umbria", provinces: [["PG", "Perugia"], ["TR", "Terni"]] },
      { code: "IT-23", name: "Valle d'Aosta", provinces: [["AO", "Aosta"]] },
      { code: "IT-34", name: "Veneto", provinces: [["BL", "Belluno"], ["PD", "Padova"], ["RO", "Rovigo"], ["TV", "Treviso"], ["VE", "Venezia"], ["VR", "Verona"], ["VI", "Vicenza"]] },
    ],
  },
};

// Provincia -> codice regione, per Paese.
function provinceIndex(country) {
  const c = GEO[country];
  const idx = {};
  if (c) c.regions.forEach(r => r.provinces.forEach(p => { idx[p[0]] = r.code; }));
  return idx;
}

module.exports = { GEO, provinceIndex };
