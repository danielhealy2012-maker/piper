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
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Based on this conversation, suggest 3 different natural replies to the last message. Each should have a different tone or approach (e.g., one direct, one humorous, one thoughtful). Return as JSON: {"replies": ["reply1", "reply2", "reply3"]}\n\n${conversationText}`,
        },
      ],
    });

    let replies = ["I'll think about it", "Sounds good", "Let me get back to you"];
    try {
      const text = textOf(response);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.replies && Array.isArray(parsed.replies) && parsed.replies.length >= 3) {
          replies = parsed.replies.slice(0, 3);
        }
      }
    } catch {
      // Fall back to defaults if parsing fails
    }

    logUsage("suggest-replies", MODEL, response.usage);
    sendJson(res, 200, { replies, model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
