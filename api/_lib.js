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

const admin =
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
