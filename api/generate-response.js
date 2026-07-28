import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf, errorMessage } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { messages, users } = await readJsonBody(req);

    if (!messages || messages.length === 0) {
      return sendJson(res, 400, { error: "no messages provided" });
    }

    // Take last 10 messages for context
    const recentMessages = messages.slice(-10);

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
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Based on this conversation, draft a natural, brief reply to the last message. Be conversational and match the tone:\n\n${conversationText}\n\nYour reply (just the text, no attribution):`,
        },
      ],
    });

    logUsage("generate-response", MODEL, response.usage);
    sendJson(res, 200, { response: textOf(response), model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
