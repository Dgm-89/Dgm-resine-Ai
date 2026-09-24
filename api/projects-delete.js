// api/projects-delete.js
// Elimina un progetto salvato dal professionista loggato. Nota: per
// semplicità questo endpoint elimina solo la riga dal database — le foto
// restano nello spazio Storage di Supabase (occupano pochissimo spazio,
// il piano gratuito ne consente parecchie migliaia prima di doversene
// preoccupare).

const { requireProSession, getSupabaseConfig, supabaseRequest } = require("./_projects-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa una richiesta POST" });
  }

  const { configured } = getSupabaseConfig();
  if (!configured) {
    return res.status(500).json({
      error: "Servizio progetti non ancora configurato (vedi le istruzioni in api/_projects-lib.js).",
    });
  }

  const pro = await requireProSession(req);
  if (!pro) {
    return res.status(401).json({ error: "Devi accedere al tuo account professionista." });
  }

  const body = req.body || {};
  const id = String(body.id || "").trim();
  if (!id) {
    return res.status(400).json({ error: "Progetto non specificato." });
  }

  try {
    const deleted = await supabaseRequest(
      "/pro_projects?id=eq." + encodeURIComponent(id) + "&pro_id=eq." + encodeURIComponent(pro.id),
      { method: "DELETE" }
    );
    if (!deleted.ok) {
      return res.status(502).json({ error: "Errore nell'eliminazione del progetto. Riprova." });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
