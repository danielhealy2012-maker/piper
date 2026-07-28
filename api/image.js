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
const REPLICATE_OWNER = "black-forest-labs";
const REPLICATE_NAME = "flux-schnell";
const MAX_PROMPT_LENGTH = 400;
const BUCKET = "backgrounds";

function promptHash(prompt) {
  return crypto.createHash("sha256").update(prompt.trim().toLowerCase()).digest("hex");
}

// Module-scope cache: survives across warm invocations of the same
// serverless instance, so most requests skip this lookup entirely. The
// classic /v1/predictions endpoint needs a specific version hash, not a
// model name — this resolves "latest" once instead of hardcoding a hash
// that would silently go stale as the model is updated upstream.
let cachedVersionId = null;
async function getLatestVersionId() {
  if (cachedVersionId) return cachedVersionId;
  const res = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_OWNER}/${REPLICATE_NAME}`, {
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`could not resolve model version (${res.status})`);
  const data = await res.json();
  const id = data?.latest_version?.id;
  if (!id) throw new Error("model has no latest_version");
  cachedVersionId = id;
  return id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `Prefer: wait` on the initial POST only holds the connection for a bounded
// window — a cold-started model (first real invocation, or one Replicate
// spun down) can still be "starting"/"processing" when that window closes,
// which is exactly what happened on the first real request. Poll the
// prediction's own status URL until it actually finishes rather than trusting
// the single initial response. Bounded to stay well inside vercel.json's
// 60s maxDuration for this function.
async function waitForPrediction(prediction) {
  let current = prediction;
  const deadline = Date.now() + 45_000;
  while (current.status !== "succeeded" && current.status !== "failed" && current.status !== "canceled") {
    if (Date.now() > deadline) throw new Error("timed out waiting for image generation");
    await sleep(1200);
    const res = await fetch(current.urls.get, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
    if (!res.ok) throw new Error(`could not poll prediction status (${res.status})`);
    current = await res.json();
  }
  return current;
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

    const version = await getLatestVersionId();
    const prediction = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json",
        // Modest explicit wait, not the bare default — leaves most of the
        // 60s function budget to the polling loop below, which has its own
        // visibility into status rather than blocking blind inside one
        // long HTTP call.
        Prefer: "wait=10",
      },
      body: JSON.stringify({
        version,
        input: {
          prompt: `${prompt}, flat illustration style, clean simple background, no text, no watermark`,
        },
      }),
    });
    if (!prediction.ok) {
      const text = await prediction.text();
      return sendJson(res, 502, { error: `image provider error: ${text.slice(0, 200)}` });
    }
    const predictionData = await waitForPrediction(await prediction.json());
    const output = Array.isArray(predictionData.output) ? predictionData.output[0] : predictionData.output;
    if (predictionData.status !== "succeeded" || !output) {
      return sendJson(res, 502, {
        error: `image generation ${predictionData.status || "failed"}${predictionData.error ? `: ${predictionData.error}` : ""}`,
      });
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
