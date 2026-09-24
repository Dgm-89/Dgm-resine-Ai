// api/projects-list.js
// Restituisce l'elenco dei progetti salvati dal professionista loggato
// (i più recenti prima), con i campi essenziali per la lista — per il
// dettaglio completo di un progetto vedi api/projects-get.js.

const { requireProSession, publicProject, getSupabaseConfig, supabaseRequest } = require("./_projects-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Usa una richiesta GET" });
  }

  const { configured } = getSupabaseConfig();
  if (!configured) {
    return res.status(200).json({ projects: [] });
  }

  const pro = await requireProSession(req);
  if (!pro) {
    return res.status(401).json({ error: "Devi accedere al tuo account professionista." });
  }

  try {
    const found = await supabaseRequest(
      "/pro_projects?pro_id=eq." + encodeURIComponent(pro.id) + "&select=*&order=created_at.desc",
      { method: "GET" }
    );
    if (!found.ok) {
      return res.status(502).json({ error: "Errore nel caricamento dei progetti. Riprova." });
    }
    const projects = (Array.isArray(found.data) ? found.data : []).map(publicProject);
    return res.status(200).json({ projects: projects });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
