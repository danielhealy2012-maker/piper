import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf, errorMessage } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { system, instruction, conversation, history } = await readJsonBody(req);
    // See api/generate.js: prior turns give references like "that" / "again" /
    // "undo that" something to resolve against.
    const historyBlock = history ? `${history}\n\n` : "";
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [
        {
          role: "user",
          content: `${historyBlock}${conversation}\n\nInstruction: ${instruction}\n\nReturn ONLY the JSON plan.`,
        },
        // Prefill "{" so the reply can only be the JSON plan.
        { role: "assistant", content: "{" },
      ],
    });
    logUsage("route", MODEL, response.usage);
    sendJson(res, 200, { raw: "{" + textOf(response), usage: response.usage, model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
