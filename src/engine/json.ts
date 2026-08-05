// Shared JSON extraction for every model response in the app.
//
// Lives in its own module rather than in generate.ts because all three model
// calls (classify, generate, route) need it, and classify.ts is imported BY
// generate.ts — leaving it in generate.ts would make that a cycle.
//
// Tolerant on purpose: /api/generate can't use assistant-prefill (it accepts a
// model override for the escalation retry, and not every model supports
// prefill), so its response may arrive with prose or a markdown fence around
// the object.
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model response");
  }
  return JSON.parse(text.slice(start, end + 1));
}
