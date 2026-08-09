import { MODEL, anthropic, logUsage, meter, readJsonBody, requireUser, sendJson, textOf, errorMessage } from "./_lib.js";

// One endpoint for both "roast me" and "compliment me" — same conversation
// context, only the tone differs, so this avoids duplicating the whole
// request/response scaffolding for what's really one feature with a knob.
function systemPromptFor(tone) {
  if (tone === "roast") {
    return "You write short, PLAYFUL, affectionate roasts — the kind friends say to each other, never mean-spirited, never about protected characteristics (appearance, race, gender, etc.), never actually hurtful. Base it on specifics from the conversation if there's anything usable (a running joke, a habit, a typo), otherwise keep it light and generic. 1-2 sentences. Output ONLY the roast, no preamble.";
  }
  return "You write short, warm, SPECIFIC compliments. Base it on something real from the conversation if there's anything usable (something they said, a habit, how they talk to the other person), otherwise keep it warm and generic. 1-2 sentences. Output ONLY the compliment, no preamble.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  if (!anthropic) return sendJson(res, 503, { error: "no_api_key" });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await meter(user, "model", res))) return;

  try {
    const { messages, users, viewerId, tone: rawTone } = await readJsonBody(req);
    const tone = rawTone === "compliment" ? "compliment" : "roast";

    if (!messages || messages.length === 0) {
      return sendJson(res, 400, { error: "no messages provided" });
    }

    const recentMessages = messages.slice(-20);
    const nameFor = (authorId) => {
      const u = users.find((x) => x.id === authorId);
      return u?.name ?? authorId;
    };
    const targetName = nameFor(viewerId);

    const conversationText = recentMessages.map((m) => `${nameFor(m.authorId)}: ${m.text}`).join("\n");

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: systemPromptFor(tone),
      messages: [
        {
          role: "user",
          content: `Conversation:\n\n${conversationText}\n\nTarget: ${targetName} (this is the person to ${tone}, not anyone else in the conversation).`,
        },
      ],
    });

    logUsage(`roast-or-compliment:${tone}`, MODEL, response.usage);
    sendJson(res, 200, { message: textOf(response).trim(), model: MODEL });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
