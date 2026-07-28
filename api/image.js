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
import { admin, errorMessage, meter, readJsonBody, requireUser, sendJson } from "./_lib.js";

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = "black-forest-labs/flux-schnell";
const MAX_PROMPT_LENGTH = 400;
const BUCKET = "backgrounds";

function promptHash(prompt) {
  return crypto.createHash("sha256").update(prompt.trim().toLowerCase()).digest("hex");
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

    // The /v1/models/{owner}/{model}/predictions shortcut 404s/adapter-errors
    // for some models depending on how they're published — the general
    // /v1/predictions endpoint with `model` in the body is the more reliably
    // documented path and works the same way for official models like this one.
    const prediction = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        model: REPLICATE_MODEL,
        input: {
          prompt: `${prompt}, flat illustration style, clean simple background, no text, no watermark`,
        },
      }),
    });
    if (!prediction.ok) {
      const text = await prediction.text();
      return sendJson(res, 502, { error: `image provider error: ${text.slice(0, 200)}` });
    }
    const predictionData = await prediction.json();
    const output = Array.isArray(predictionData.output) ? predictionData.output[0] : predictionData.output;
    if (predictionData.status !== "succeeded" || !output) {
      return sendJson(res, 502, { error: `image generation ${predictionData.status || "failed"}` });
    }

    // Re-host: Replicate's own delivery URL isn't guaranteed permanent —
    // download it once and store our own copy for a stable long-term URL.
    const imageRes = await fetch(output);
    if (!imageRes.ok) return sendJson(res, 502, { error: "failed to fetch generated image" });
    const contentType = imageRes.headers.get("content-type") || "image/webp";
    const ext = contentType.includes("png") ? "png" : contentType.includes("jpeg") ? "jpg" : "webp";
    const buffer = Buffer.from(await imageRes.arrayBuffer());

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
