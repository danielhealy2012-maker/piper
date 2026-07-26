import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { messages, users } = await readJsonBody(req);

    // Take last 20 messages
    const recentMessages = messages.slice(-20);

    // Build conversation text
    const nameFor = (authorId) => {
      const u = users.find((x) => x.id === authorId);
      return u?.name ?? authorId;
    };

    const conversationText = recentMessages
      .map((m) => `${nameFor(m.authorId)}: ${m.text}`)
      .join("\n");

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Summarize this conversation in 1-2 sentences, capturing the main topic and any key decisions or outcomes:\n\n${conversationText}`,
        },
      ],
    });

    logUsage("summarize", MODEL, response.usage);
    sendJson(res, 200, { summary: textOf(response), model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
