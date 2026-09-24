// api/projects-create.js
// Salva un nuovo progetto nella cartella del professionista loggato: dati
// cliente, foto prima/dopo (facoltative) e i dettagli di materiale/colore/
// finitura già calcolati dal configuratore. Vedi api/_projects-lib.js per
// come attivare la tabella e lo spazio foto su Supabase.

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
    return res.status(401).json({ error: "Devi accedere al tuo account professionista per salvare un progetto." });
  }

  const body = req.body || {};
  const clientName = String(body.clientName || "").trim();
  if (!clientName) {
    return res.status(400).json({ error: "Il nome del cliente è obbligatorio." });
  }

  try {
    const [photoBeforeUrl, photoAfterUrl] = await Promise.all([
      uploadPhoto(body.photoBeforeDataUrl, pro.id),
      uploadPhoto(body.photoAfterDataUrl, pro.id),
    ]);

    const inserted = await supabaseRequest("/pro_projects", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([
        {
          pro_id: pro.id,
          client_name: clientName,
          client_contact: String(body.clientContact || "").trim() || null,
          site_address: String(body.siteAddress || "").trim() || null,
          photo_before_url: photoBeforeUrl,
          photo_after_url: photoAfterUrl,
          material: String(body.material || "").trim() || null,
          color_name: String(body.colorName || "").trim() || null,
          color_code: String(body.colorCode || "").trim() || null,
          finish: String(body.finish || "").trim() || null,
          notes: String(body.notes || "").trim() || null,
        },
      ]),
    });

    if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) {
      return res.status(502).json({ error: "Errore nel salvataggio del progetto. Riprova." });
    }

    return res.status(200).json({ ok: true, project: publicProject(inserted.data[0]) });
  } catch (err) {
    return res.status(500).json({ error: "Errore imprevisto durante il salvataggio. Riprova." });
  }
};
