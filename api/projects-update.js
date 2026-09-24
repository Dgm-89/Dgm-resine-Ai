// api/projects-update.js
// Modifica un progetto già salvato (es. il cliente ha cambiato il colore
// scelto, o il pro vuole correggere/aggiornare una foto). Solo il
// professionista che ha creato il progetto può modificarlo.

const { requireProSession, uploadPhoto, publicProject, getSupabaseConfig, supabaseRequest } = require("./_projects-lib");

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
    // Verifica che il progetto esista e appartenga a questo professionista,
    // prima di modificarlo — nessun altro pro deve poter toccarlo.
    const existing = await supabaseRequest(
      "/pro_projects?id=eq." + encodeURIComponent(id) + "&pro_id=eq." + encodeURIComponent(pro.id) + "&select=id",
      { method: "GET" }
    );
    if (!existing.ok || !Array.isArray(existing.data) || !existing.data[0]) {
      return res.status(404).json({ error: "Progetto non trovato." });
    }

    const patch = {};
    if (body.clientName !== undefined) patch.client_name = String(body.clientName || "").trim();
    if (body.clientContact !== undefined) patch.client_contact = String(body.clientContact || "").trim() || null;
    if (body.siteAddress !== undefined) patch.site_address = String(body.siteAddress || "").trim() || null;
    if (body.material !== undefined) patch.material = String(body.material || "").trim() || null;
    if (body.colorName !== undefined) patch.color_name = String(body.colorName || "").trim() || null;
    if (body.colorCode !== undefined) patch.color_code = String(body.colorCode || "").trim() || null;
    if (body.finish !== undefined) patch.finish = String(body.finish || "").trim() || null;
    if (body.notes !== undefined) patch.notes = String(body.notes || "").trim() || null;
    patch.updated_at = new Date().toISOString();

    // Le foto vengono sostituite solo se ne arriva una nuova (evita di
    // ricaricare/perdere quella già salvata a ogni piccola modifica testuale).
    if (body.photoBeforeDataUrl) {
      const url = await uploadPhoto(body.photoBeforeDataUrl, pro.id);
      if (url) patch.photo_before_url = url;
    }
    if (body.photoAfterDataUrl) {
      const url = await uploadPhoto(body.photoAfterDataUrl, pro.id);
      if (url) patch.photo_after_url = url;
    }

    const updated = await supabaseRequest(
      "/pro_projects?id=eq." + encodeURIComponent(id) + "&pro_id=eq." + encodeURIComponent(pro.id),
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      }
    );

    if (!updated.ok || !Array.isArray(updated.data) || !updated.data[0]) {
      return res.status(502).json({ error: "Errore nell'aggiornamento del progetto. Riprova." });
    }

    return res.status(200).json({ ok: true, project: publicProject(updated.data[0]) });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto. Riprova." });
  }
};
