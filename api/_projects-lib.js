// api/_projects-lib.js
// Funzioni condivise dagli endpoint "cartella progetti" (projects-*.js), che
// permettono a un professionista loggato di salvare qui i progetti fatti per
// i propri clienti (nome cliente, foto prima/dopo, materiale/colore scelti),
// così non deve più tenerli sul telefono.
//
// Il file "_auth-lib.js" (leggi prima quello) spiega come attivare Supabase
// per il login. Per la cartella progetti serve UN PASSAGGIO IN PIÙ, da fare
// una volta sola, sempre dentro lo stesso progetto Supabase già creato:
//
// 1. Nel "SQL Editor" di Supabase, esegui questo comando per creare la
//    tabella dei progetti (in aggiunta a "pro_accounts" già creata):
//
//      create table pro_projects (
//        id uuid primary key default gen_random_uuid(),
//        pro_id uuid not null references pro_accounts(id) on delete cascade,
//        client_name text not null,
//        client_contact text,
//        site_address text,
//        photo_before_url text,
//        photo_after_url text,
//        material text,
//        color_name text,
//        color_code text,
//        finish text,
//        notes text,
//        created_at timestamptz not null default now(),
//        updated_at timestamptz not null default now()
//      );
//
// 2. Nel menu a sinistra vai su "Storage" → "Create a new bucket". Chiamalo
//    esattamente:  project-photos
//    e spunta l'opzione "Public bucket" (così le foto si vedono nell'app
//    senza passaggi extra). Non serve nessun'altra configurazione.
// 3. Non servono nuove variabili d'ambiente: questa parte usa le stesse
//    SUPABASE_URL / SUPABASE_SERVICE_KEY / JWT_SECRET già impostate per il
//    login (vedi api/_auth-lib.js).
//
// Finché questi due passaggi non sono fatti, gli endpoint sotto rispondono
// con un errore chiaro invece di andare in crash.

const crypto = require("crypto");
const { getSupabaseConfig, supabaseRequest, readSessionCookie, verifySession } = require("./_auth-lib");

// Verifica che la richiesta arrivi da un professionista con sessione valida.
// Restituisce la riga account (con id) oppure null se non autenticato.
async function requireProSession(req) {
  const token = readSessionCookie(req);
  const session = token ? verifySession(token) : null;
  if (!session || !session.sub) return null;
  const found = await supabaseRequest(
    "/pro_accounts?id=eq." + encodeURIComponent(session.sub) + "&select=id,tier",
    { method: "GET" }
  );
  if (!found.ok || !Array.isArray(found.data) || !found.data[0]) return null;
  return found.data[0];
}

// Carica una foto (arrivata dal frontend come data URL base64) su Supabase
// Storage e restituisce l'indirizzo pubblico da salvare nel database.
// "dataUrl" è tipo "data:image/jpeg;base64,/9j/4AAQ..." — se è vuoto o non
// valido restituisce null (la foto è facoltativa).
async function uploadPhoto(dataUrl, folder) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2];
  const ext = mime.split("/")[1] || "jpg";
  const fileName = crypto.randomBytes(12).toString("hex") + "." + ext;
  const path = folder + "/" + fileName;

  const { url, key } = getSupabaseConfig();
  const buffer = Buffer.from(base64, "base64");
  const response = await fetch(url + "/storage/v1/object/project-photos/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      apikey: key,
      "Content-Type": mime,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!response.ok) return null;
  return url + "/storage/v1/object/public/project-photos/" + path;
}

// Converte una riga del database nel formato usato dal frontend.
function publicProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientName: row.client_name,
    clientContact: row.client_contact,
    siteAddress: row.site_address,
    photoBeforeUrl: row.photo_before_url,
    photoAfterUrl: row.photo_after_url,
    material: row.material,
    colorName: row.color_name,
    colorCode: row.color_code,
    finish: row.finish,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  requireProSession,
  uploadPhoto,
  publicProject,
  getSupabaseConfig,
  supabaseRequest,
};
