import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf, errorMessage } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { system, instruction, spec, model } = await readJsonBody(req);
    const chosenModel = model || MODEL;
    const response = await anthropic.messages.create({
      model: chosenModel,
      max_tokens: 1500,
      system,
      messages: [
        {
          role: "user",
          content: `Current spec:\n${JSON.stringify(spec)}\n\nInstruction: ${instruction}\n\nReturn ONLY the {"spec":...,"summary":...,"limitation":...} JSON object described in the system prompt.`,
        },
        // Prefill "{" so the reply can only be that JSON object.
        { role: "assistant", content: "{" },
      ],
    });
    logUsage("generate", chosenModel, response.usage);
    sendJson(res, 200, { raw: "{" + textOf(response), usage: response.usage, model: chosenModel });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
