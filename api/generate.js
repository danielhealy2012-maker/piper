import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf, errorMessage } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { system, instruction, spec, history, model } = await readJsonBody(req);
    const chosenModel = model || MODEL;
    // Prior turns of this session, so "make it more like that" / "a bit less"
    // have a referent. Placed BEFORE the spec and instruction so the thing
    // being acted on is the last thing read. Omitted entirely on a fresh
    // session rather than sent as an empty section.
    const historyBlock = history ? `${history}\n\n` : "";
    // No assistant-prefill here (unlike route.js/translate.js): this endpoint
    // accepts a model OVERRIDE (used for the escalation retry to
    // claude-opus-4-8), and not every model supports prefill — one that
    // doesn't 400s with "This model does not support assistant message
    // prefill." extractJson() on the client already finds the JSON object
    // wherever it lands in the response, prefixed or not.
    const response = await anthropic.messages.create({
      model: chosenModel,
      // The full spec (theme + customCSSText/customCSS/customEffects/
      // customComponents, all echoed back on every request, including any
      // real component source code) can genuinely be a few thousand tokens
      // once a session has accumulated a few of these — 1500 was fine for a
      // bare theme spec but silently truncated mid-JSON as soon as escape
      // hatches were in heavy use, which is a much worse failure than the
      // extra cost of headroom here.
      max_tokens: 8000,
      system,
      messages: [
        {
          role: "user",
          content: `${historyBlock}Current spec:\n${JSON.stringify(spec)}\n\nInstruction: ${instruction}\n\nReturn ONLY the {"spec":...,"summary":...,"limitation":...,"backgroundImagePrompt":...} JSON object described in the system prompt.`,
        },
      ],
    });
    logUsage("generate", chosenModel, response.usage);
    sendJson(res, 200, { raw: textOf(response), usage: response.usage, model: chosenModel });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
