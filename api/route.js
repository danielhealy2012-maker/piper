import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { system, instruction, conversation } = await readJsonBody(req);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [
        {
          role: "user",
          content: `${conversation}\n\nInstruction: ${instruction}\n\nReturn ONLY the JSON plan.`,
        },
        // Prefill "{" so the reply can only be the JSON plan.
        { role: "assistant", content: "{" },
      ],
    });
    logUsage("route", MODEL, response.usage);
    sendJson(res, 200, { raw: "{" + textOf(response), usage: response.usage, model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
