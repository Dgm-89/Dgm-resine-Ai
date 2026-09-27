// api/pro-profile.js
// Profilo pubblico dell'artigiano per "Trova il tuo artigiano".
//   GET  /api/pro-profile?action=me              -> profilo del professionista loggato
//   POST /api/pro-profile?action=save            -> salva il profilo (tutti i campi obbligatori)
//   GET  /api/pro-profile?action=list&country=IT&province=MI&lav=monolith
//                                                -> artigiani visibili che lavorano in quella provincia/lavorazione
const { currentAccount, supabaseRequest, getSupabaseConfig, paymentsEnabled } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");
const { GEO, provinceIndex } = require("./_geo");

const LAVORAZIONI = ["monolith", "microcemento", "scale", "imbiancatura", "resina_haccp", "spc", "laminato", "parquet", "piastrelle", "graniglia_esterni"];
const TIER_RANK = { pro: 3, medium: 2, basic: 1 };

function clean(v, max) { return String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, max); }
function codeList(v, re, max) {
  return (Array.isArray(v) ? v : []).map(x => String(x).toUpperCase().trim()).filter(x => re.test(x)).slice(0, max);
}
function publicProfile(row, withPrivate) {
  const p = {
    id: row.id,
    companyName: row.company_name || "",
    logoUrl: row.logo_url || null,
    bio: row.profile_bio || "",
    city: row.profile_city || "",
    website: row.profile_website || "",
    country: row.profile_country || "IT",
    regions: row.profile_regions || [],
    provinces: row.profile_provinces || [],
    lavorazioni: row.profile_lavorazioni || [],
    gallery: row.profile_gallery || [],
    visible: !!row.profile_public,
    tier: row.tier,
  };
  if (withPrivate) { p.phone = row.phone || ""; p.email = row.email; p.accountType = row.account_type; }
  return p;
}

module.exports = async function handler(req, res) {
  if (!getSupabaseConfig().configured) return res.status(500).json({ error: "Servizio non configurato." });
  const action = (req.query && req.query.action) || "";
  try {
    if (action === "list") {
      if (req.method !== "GET") return res.status(405).json({ error: "Usa GET" });
      const country = String(req.query.country || "IT").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      const prov = String(req.query.province || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
      const lav = String(req.query.lav || "").replace(/[^a-z_]/g, "");
      if (!GEO[country] || !provinceIndex(country)[prov] || !LAVORAZIONI.includes(lav)) return res.status(400).json({ error: "Indica provincia e lavorazione." });
      let q = "/pro_accounts?select=id,company_name,logo_url,profile_bio,profile_city,profile_website,profile_country,profile_regions,profile_provinces,profile_lavorazioni,profile_gallery,profile_public,tier,subscription_status"
        + "&profile_public=eq.true&profile_country=eq." + country
        + "&profile_provinces=cs." + encodeURIComponent("{" + prov + "}")
        + "&profile_lavorazioni=cs." + encodeURIComponent("{" + lav + "}");
      if (paymentsEnabled()) q += "&subscription_status=in.(active,trialing)";
      const r = await supabaseRequest(q, { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "Ricerca non riuscita. Riprova." });
      const list = (Array.isArray(r.data) ? r.data : []).map(x => publicProfile(x, false))
        .sort((a, b) => (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0));
      list.forEach(p => { delete p.tier; delete p.visible; });
      return res.status(200).json({ artisans: list });
    }

    const acc = await currentAccount(req).catch(() => null);
    if (!acc) return res.status(401).json({ error: "Accedi al tuo account." });
    if (acc.account_type === "privato") return res.status(403).json({ error: "Il profilo artigiano è riservato ai professionisti." });

    if (action === "me") return res.status(200).json({ profile: publicProfile(acc, true) });

    if (action === "save") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const b = req.body || {};
      const companyName = clean(b.companyName, 120);
      const bio = clean(b.bio, 1500);
      const city = clean(b.city, 80);
      const phone = clean(b.phone, 30);
      const website = clean(b.website, 200);
      const country = String(b.country || "IT").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2) || "IT";
      if (!GEO[country]) return res.status(400).json({ error: "Paese non ancora disponibile." });
      // Le province devono esistere; le regioni si ricavano dalle province (niente dati incoerenti).
      const pIdx = provinceIndex(country);
      const provinces = Array.from(new Set(codeList(b.provinces, /^[A-Z]{2,3}$/, 200).filter(p => pIdx[p])));
      const regions = Array.from(new Set(provinces.map(p => pIdx[p])));
      const lavorazioni = Array.from(new Set((Array.isArray(b.lavorazioni) ? b.lavorazioni : []).filter(x => LAVORAZIONI.includes(x))));
      // Si accettano solo foto già caricate da questo account nel nostro archivio.
      const ownPrefix = getSupabaseConfig().url + "/storage/v1/object/public/project-photos/profiles/" + acc.id + "/";
      let gallery = Array.from(new Set((Array.isArray(b.gallery) ? b.gallery : []).filter(u => typeof u === "string" && u.startsWith(ownPrefix)))).slice(0, 8);
      const newPhotos = (Array.isArray(b.newPhotos) ? b.newPhotos : []).filter(x => typeof x === "string" && x.startsWith("data:image/")).slice(0, 8 - gallery.length);

      const errs = [];
      if (companyName.length < 2) errs.push("nome dell'attività");
      if (bio.length < 60) errs.push("descrizione (almeno 60 caratteri)");
      if (city.length < 2) errs.push("sede (comune)");
      if (phone.replace(/\D/g, "").length < 6) errs.push("telefono");
      if (!provinces.length) errs.push("province in cui lavori");
      if (!lavorazioni.length) errs.push("lavorazioni che fai");
      if (gallery.length + newPhotos.length < 3) errs.push("almeno 3 foto dei tuoi lavori");
      if (!acc.logo_url && !(typeof b.newLogo === "string" && b.newLogo.startsWith("data:image/"))) errs.push("logo");
      if (website && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(website)) errs.push("sito web valido (https://…)");
      // Prima si controlla tutto, poi si caricano le foto: niente file orfani.
      if (errs.length) return res.status(400).json({ error: "Completa: " + errs.join(", ") + "." });

      for (const ph of newPhotos) {
        if (gallery.length >= 8) break;
        const url = await uploadPhoto(ph, "profiles/" + acc.id);
        if (url) gallery.push(url);
      }
      let logoUrl = acc.logo_url || null;
      if (typeof b.newLogo === "string" && b.newLogo.startsWith("data:image/")) {
        const u = await uploadPhoto(b.newLogo, "logos/" + acc.id); if (u) logoUrl = u;
      }
      if (gallery.length < 3 || !logoUrl) return res.status(400).json({ error: "Alcune foto non sono valide (usa JPG, PNG o WebP). Riprova.", gallery, logoUrl });

      const fields = {
        company_name: companyName, phone, logo_url: logoUrl,
        profile_bio: bio, profile_city: city, profile_website: website || null,
        profile_country: country, profile_regions: regions, profile_provinces: provinces,
        profile_lavorazioni: lavorazioni, profile_gallery: gallery,
        profile_public: b.visible !== false,
      };
      const u = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(acc.id), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) });
      if (!u.ok) { console.error("pro-profile save", u.data); return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." }); }
      const row = Array.isArray(u.data) && u.data[0] ? u.data[0] : Object.assign({}, acc, fields);
      return res.status(200).json({ ok: true, profile: publicProfile(row, true) });
    }
    return res.status(404).json({ error: "Azione sconosciuta" });
  } catch (err) {
    console.error("pro-profile", err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
