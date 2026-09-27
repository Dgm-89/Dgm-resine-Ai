// api/_vat.js — controllo partita IVA (libreria, non è una funzione Vercel).
// Italia: controllo completo della cifra di controllo.
// UE ed extra-UE: controllo del formato ufficiale del Paese.
// Lo stesso codice è copiato nel frontend (index.html, VAT_RULES / vatCheck).
const VAT_RULES = {
  IT: { name: "Italia", re: /^\d{11}$/ },
  AT: { name: "Austria", re: /^U\d{8}$/ },
  BE: { name: "Belgio", re: /^[01]\d{9}$/ },
  BG: { name: "Bulgaria", re: /^\d{9,10}$/ },
  CY: { name: "Cipro", re: /^\d{8}[A-Z]$/ },
  CZ: { name: "Repubblica Ceca", re: /^\d{8,10}$/ },
  DE: { name: "Germania", re: /^\d{9}$/ },
  DK: { name: "Danimarca", re: /^\d{8}$/ },
  EE: { name: "Estonia", re: /^\d{9}$/ },
  GR: { name: "Grecia", re: /^\d{9}$/, prefix: "EL" },
  ES: { name: "Spagna", re: /^[A-Z0-9]\d{7}[A-Z0-9]$/ },
  FI: { name: "Finlandia", re: /^\d{8}$/ },
  FR: { name: "Francia", re: /^[A-HJ-NP-Z0-9]{2}\d{9}$/ },
  HR: { name: "Croazia", re: /^\d{11}$/ },
  HU: { name: "Ungheria", re: /^\d{8}$/ },
  IE: { name: "Irlanda", re: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/ },
  LT: { name: "Lituania", re: /^(\d{9}|\d{12})$/ },
  LU: { name: "Lussemburgo", re: /^\d{8}$/ },
  LV: { name: "Lettonia", re: /^\d{11}$/ },
  MT: { name: "Malta", re: /^\d{8}$/ },
  NL: { name: "Paesi Bassi", re: /^\d{9}B\d{2}$/ },
  PL: { name: "Polonia", re: /^\d{10}$/ },
  PT: { name: "Portogallo", re: /^\d{9}$/ },
  RO: { name: "Romania", re: /^\d{2,10}$/ },
  SE: { name: "Svezia", re: /^\d{10}01$/ },
  SI: { name: "Slovenia", re: /^\d{8}$/ },
  SK: { name: "Slovacchia", re: /^\d{10}$/ },
  SM: { name: "San Marino", re: /^\d{5}$/ },
  CH: { name: "Svizzera", re: /^\d{9}(MWST|TVA|IVA)?$/, prefix: "CHE" },
  GB: { name: "Regno Unito", re: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/ },
  XX: { name: "Altro Paese", re: /^[A-Z0-9]{5,20}$/ },
};
function itChecksum(p) {
  if (/^0{7}/.test(p)) return false;
  let s = 0;
  for (let i = 0; i < 10; i++) {
    let d = +p[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    s += d;
  }
  return (10 - (s % 10)) % 10 === +p[10];
}
// Restituisce { ok, country, number, display, error }
function vatCheck(country, raw) {
  const c = VAT_RULES[country] ? country : "IT";
  const rule = VAT_RULES[c];
  let n = String(raw || "").toUpperCase().replace(/[\s.\-\/]/g, "");
  const pref = rule.prefix || c;
  if (c !== "XX" && n.startsWith(pref)) n = n.slice(pref.length);
  if (!n) return { ok: false, country: c, number: "", error: "Inserisci la partita IVA." };
  if (!rule.re.test(n)) return { ok: false, country: c, number: n, error: "La partita IVA non ha il formato corretto per " + rule.name + "." };
  if (c === "IT" && !itChecksum(n)) return { ok: false, country: c, number: n, error: "La partita IVA non è valida: controlla le cifre." };
  const display = c === "IT" ? n : (c === "XX" ? n : pref + n);
  return { ok: true, country: c, number: n, display };
}
module.exports = { VAT_RULES, vatCheck };
