// Generates a background image on demand (Replicate / Flux-schnell), caches
// it in Supabase Storage keyed by a hash of the prompt, and returns a stable
// public URL. Repeat requests for the "same" background are served from the
// generated_backgrounds cache table with no generation call and no cost.
//
// The model (generate.ts's buildSystemPrompt) never sees or sets the
// resulting URL — it only authors the text prompt; this endpoint is the only
// code that ever writes a wallpaperUrl value, which is what lets spec.ts
// validate that field against this project's own Storage host and reject
// anything else.
import crypto from "node:crypto";
import { admin, errorMessage, generateImageBuffer, meter, readJsonBody, requireUser, sendJson, REPLICATE_TOKEN } from "./_lib.js";

const MAX_PROMPT_LENGTH = 400;
const BUCKET = "backgrounds";
const STYLE_SUFFIX = "flat illustration style, clean simple background, no text, no watermark";

function promptHash(prompt) {
  // "background:" namespace so an avatar and a background generated from the
  // same words (api/avatar.js hashes with a different namespace) never
  // collide in the shared generated_backgrounds cache table.
  return crypto.createHash("sha256").update(`background:${prompt.trim().toLowerCase()}`).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!REPLICATE_TOKEN) return sendJson(res, 503, { error: "no_image_provider_configured" });
  if (!admin) return sendJson(res, 503, { error: "no_storage_configured" });

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const { prompt: rawPrompt } = await readJsonBody(req);
    const prompt = String(rawPrompt ?? "").trim().slice(0, MAX_PROMPT_LENGTH);
    if (!prompt) return sendJson(res, 400, { error: "empty_prompt" });

    const hash = promptHash(prompt);

    // Cache hit: no metering, no generation call, no cost.
    const { data: cached } = await admin
      .from("generated_backgrounds")
      .select("url")
      .eq("prompt_hash", hash)
      .maybeSingle();
    if (cached?.url) {
      return sendJson(res, 200, { url: cached.url, cached: true });
    }

    if (!(await meter(user, "image", res))) return;

    const { buffer, contentType, ext } = await generateImageBuffer(prompt, STYLE_SUFFIX);

    // Re-host: Replicate's own delivery URL isn't guaranteed permanent —
    // download it once and store our own copy for a stable long-term URL.
    const path = `${hash}.${ext}`;
    const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, buffer, {
      contentType,
      upsert: true,
    });
    if (uploadError) throw uploadError;

    const { data: publicUrlData } = admin.storage.from(BUCKET).getPublicUrl(path);
    const url = publicUrlData.publicUrl;

    await admin.from("generated_backgrounds").insert({ prompt_hash: hash, prompt, url, created_by: user.id });

    sendJson(res, 200, { url, cached: false });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
