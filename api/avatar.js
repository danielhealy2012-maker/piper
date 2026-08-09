// Generates a custom avatar on demand (Replicate / Flux-schnell) and writes
// it straight to the caller's own profiles.avatar_url — Phase 2 #11.
//
// Unlike a background, an avatar IS the caller's identity as the other
// person sees it, so this writes profiles (shared/public-read), not a
// personal table. The RLS on profiles already allows `id = auth.uid()` to
// update their own row (0001_init.sql profiles_write) — but that policy only
// proves WHO may write, not WHAT they write, and a client with that raw
// access could set avatar_url to any external URL it wants (a tracking
// pixel, something abusive hosted elsewhere). So the client is never given
// direct write access to this column at all: only this endpoint (service
// role, via `admin`) sets it, and only after generating the image itself —
// the same "model authors a prompt, server owns the URL" trust boundary
// wallpaperUrl already established for backgrounds.
import crypto from "node:crypto";
import { admin, errorMessage, generateImageBuffer, meter, readJsonBody, requireUser, sendJson, REPLICATE_TOKEN } from "./_lib.js";

const MAX_PROMPT_LENGTH = 400;
const BUCKET = "backgrounds"; // shared bucket, distinct path prefix — see 0002_image_storage.sql
const STYLE_SUFFIX = "portrait avatar icon, centered subject, simple flat background, no text, no watermark";

function promptHash(prompt) {
  // "avatar:" namespace so this never collides with api/image.js's cache
  // rows for the same prompt text in the shared generated_backgrounds table.
  return crypto.createHash("sha256").update(`avatar:${prompt.trim().toLowerCase()}`).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!REPLICATE_TOKEN) return sendJson(res, 503, { error: "no_image_provider_configured" });
  if (!admin) return sendJson(res, 503, { error: "no_storage_configured" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (user.anonymous) return sendJson(res, 401, { error: "not_signed_in" });

  try {
    const { prompt: rawPrompt } = await readJsonBody(req);
    const prompt = String(rawPrompt ?? "").trim().slice(0, MAX_PROMPT_LENGTH);
    if (!prompt) return sendJson(res, 400, { error: "empty_prompt" });

    const hash = promptHash(prompt);

    let url;
    const { data: cached } = await admin
      .from("generated_backgrounds")
      .select("url")
      .eq("prompt_hash", hash)
      .maybeSingle();

    if (cached?.url) {
      url = cached.url;
    } else {
      if (!(await meter(user, "image", res))) return;

      const { buffer, contentType, ext } = await generateImageBuffer(prompt, STYLE_SUFFIX);
      const path = `avatar-${hash}.${ext}`;
      const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, buffer, {
        contentType,
        upsert: true,
      });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = admin.storage.from(BUCKET).getPublicUrl(path);
      url = publicUrlData.publicUrl;

      await admin.from("generated_backgrounds").insert({ prompt_hash: hash, prompt, url, created_by: user.id });
    }

    const { error: profileError } = await admin.from("profiles").update({ avatar_url: url }).eq("id", user.id);
    if (profileError) throw profileError;

    sendJson(res, 200, { url });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
