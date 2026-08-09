// Shared helpers for the deployed serverless functions.
//
// Same key-safety principle as the local proxy: ANTHROPIC_API_KEY lives only in
// the function environment and never reaches the browser or the bundle. The
// difference in production is that these endpoints are PUBLIC, so every one of
// them verifies the caller's Supabase session and meters their usage.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const MODEL = process.env.PIPER_MODEL || "claude-haiku-4-5";

export const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// Exported (not module-private) so endpoints that need direct table/storage
// access beyond requireUser/meter — currently just api/image.js, for the
// generated_backgrounds cache table and the "backgrounds" storage bucket —
// can use it. Always the service role client; RLS is bypassed intentionally
// for these server-only writes.
export const admin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

/** Per-user daily caps across the paid endpoints. */
const DAILY_LIMITS = { model: 300, image: 40 };

export function sendJson(res, status, body) {
  res.status(status).json(body);
}

/** Verifies the Supabase access token from the Authorization header. */
export async function requireUser(req, res) {
  if (!admin) {
    // No Supabase configured (e.g. a preview deploy): fall back to open access
    // rather than breaking, but never in a deployment that has the keys set.
    return { id: null, anonymous: true };
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    sendJson(res, 401, { error: "not_signed_in" });
    return null;
  }
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) {
    sendJson(res, 401, { error: "invalid_session" });
    return null;
  }
  return { id: data.user.id, anonymous: false };
}

/** Counts today's usage and rejects once the cap is hit. */
export async function meter(user, kind, res) {
  if (!admin || user.anonymous) return true;
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const { count } = await admin
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("kind", kind)
    .gte("created_at", since.toISOString());

  if ((count ?? 0) >= (DAILY_LIMITS[kind] ?? 100)) {
    sendJson(res, 429, { error: "daily_limit_reached", kind });
    return false;
  }
  await admin.from("usage_events").insert({ user_id: user.id, kind });
  return true;
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function textOf(response) {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function sliceJson(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON in response");
  return JSON.parse(raw.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Shared Replicate/Flux image generation — used by both api/image.js
// (backgrounds) and api/avatar.js (Phase 2 #11). Factored out because the
// polling loop below fixes a real bug (751aa12-adjacent: `Prefer: wait` only
// holds the connection for a bounded window, and a cold-started model can
// still be mid-flight when it closes) — duplicating this into a second file
// would risk the fix living in only one of them.
// ---------------------------------------------------------------------------
export const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_OWNER = "black-forest-labs";
const REPLICATE_NAME = "flux-schnell";

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

/** Generates one image and returns its raw bytes — caller decides where it
 *  gets stored/cached. `styleSuffix` is appended to the prompt (backgrounds
 *  and avatars want different framing: a scene vs. a centered portrait). */
export async function generateImageBuffer(prompt, styleSuffix) {
  const version = await getLatestVersionId();
  const prediction = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json",
      // Modest explicit wait, not the bare default — leaves most of the 60s
      // function budget to the polling loop, which has its own visibility
      // into status rather than blocking blind inside one long HTTP call.
      Prefer: "wait=10",
    },
    body: JSON.stringify({ version, input: { prompt: `${prompt}, ${styleSuffix}` } }),
  });
  if (!prediction.ok) {
    const text = await prediction.text();
    throw new Error(`image provider error: ${text.slice(0, 200)}`);
  }
  const predictionData = await waitForPrediction(await prediction.json());
  const output = Array.isArray(predictionData.output) ? predictionData.output[0] : predictionData.output;
  if (predictionData.status !== "succeeded" || !output) {
    throw new Error(`image generation ${predictionData.status || "failed"}${predictionData.error ? `: ${predictionData.error}` : ""}`);
  }

  const imageRes = await fetch(output);
  if (!imageRes.ok) throw new Error("failed to fetch generated image");
  const contentType = imageRes.headers.get("content-type") || "image/webp";
  const ext = contentType.includes("png") ? "png" : contentType.includes("jpeg") ? "jpg" : "webp";
  const buffer = Buffer.from(await imageRes.arrayBuffer());
  return { buffer, contentType, ext };
}

export function logUsage(label, model, usage) {
  console.log(
    `[piper] ${label} model=${model} input_tokens=${usage?.input_tokens ?? "?"} output_tokens=${usage?.output_tokens ?? "?"}`,
  );
}

/** Anthropic/Supabase SDK errors are often plain objects, not Error instances
 *  — `String(err)` on those degrades to "[object Object]" instead of the
 *  actual reason, which then surfaces verbatim in the client UI. */
export function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return "Something went wrong";
}
