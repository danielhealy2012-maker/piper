import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf, errorMessage } from "./_lib.js";

// Stage 1 of theme generation (see src/engine/classify.ts): decide which
// mechanisms an instruction needs so the specialist call can be given only
// those instructions.
//
// Deliberately the cheapest endpoint here: no spec, no conversation, no
// history — just the instruction. Small max_tokens because the entire valid
// response is a short array of flags; a bigger budget would only buy room for
// the model to explain itself, which this call has no use for.
export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { system, instruction } = await readJsonBody(req);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      system,
      messages: [
        { role: "user", content: `Instruction: ${instruction}\n\nReturn ONLY the JSON object.` },
        // Prefill "{" so the reply can only be the JSON object.
        { role: "assistant", content: "{" },
      ],
    });
    logUsage("classify", MODEL, response.usage);
    sendJson(res, 200, { raw: "{" + textOf(response), usage: response.usage, model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
