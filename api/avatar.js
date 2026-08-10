// Generates a custom avatar on demand (Replicate / Flux-schnell) and writes
// it to a profiles.avatar_url row — Phase 2 #11.
//
// Unlike a background, an avatar IS someone's identity as seen across the
// app, so this writes profiles (shared/public-read), not a personal table.
// The RLS on profiles already allows `id = auth.uid()` to update their own
// row (0001_init.sql profiles_write) — but that policy only proves WHO may
// write, not WHAT they write, and a client with that raw access could set
// avatar_url to any external URL it wants (a tracking pixel, something
// abusive hosted elsewhere). So the client is never given direct write
// access to this column at all: only this endpoint (service role, via
// `admin`) sets it, and only after generating the image itself — the same
// "model authors a prompt, server owns the URL" trust boundary wallpaperUrl
// already established for backgrounds.
//
// Either participant may set either avatar — no approval step, matching the
// trust model messages/reactions/shared components already have (explicit
// product decision: whatever one person sets applies, full stop). The one
// guardrail that IS enforced: `targetUserId` must be a member of the SAME
// conversation as the caller, via conversation_members — otherwise any
// signed-in user could deface any other user's profile app-wide, which is a
// materially different (and unbounded) risk than one participant setting
// their conversation partner's avatar.
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
    const { prompt: rawPrompt, conversationId, targetUserId: rawTarget } = await readJsonBody(req);
    const prompt = String(rawPrompt ?? "").trim().slice(0, MAX_PROMPT_LENGTH);
    if (!prompt) return sendJson(res, 400, { error: "empty_prompt" });
    const targetUserId = rawTarget || user.id;

    if (targetUserId !== user.id) {
      if (!conversationId) return sendJson(res, 400, { error: "missing_conversation_id" });
      const { data: members, error: memberError } = await admin
        .from("conversation_members")
        .select("user_id")
        .eq("conversation_id", conversationId)
        .in("user_id", [user.id, targetUserId]);
      if (memberError) throw memberError;
      const ids = new Set((members ?? []).map((m) => m.user_id));
      if (!ids.has(user.id) || !ids.has(targetUserId)) {
        return sendJson(res, 403, { error: "not_a_shared_conversation" });
      }
    }

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

    const { error: profileError } = await admin.from("profiles").update({ avatar_url: url }).eq("id", targetUserId);
    if (profileError) throw profileError;

    sendJson(res, 200, { url });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
