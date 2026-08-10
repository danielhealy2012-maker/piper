import { z } from "zod";
import type { ChatMessage } from "../lib/types";
import type { DisplayUser } from "../lib/backend";
import { GENRES, GENRE_NAMES } from "./genres";

// ---------------------------------------------------------------------------
// The action catalog. This is the bounded vocabulary the router may choose
// from — the message-content analogue of the theme registry. The model decides
// WHICH actions and fills their parameters; the pure appliers below are the
// only code that mutates the conversation, so nothing the model returns can
// reach the DOM without passing through a typed, validated executor.
// ---------------------------------------------------------------------------

export const MessageActionSchema = z.discriminatedUnion("kind", [
  // Read/translate
  z.object({
    kind: z.literal("translateMessage"),
    messageId: z.string(),
    targetLanguage: z.string().min(1).max(40),
  }),
  // Write: edit, delete
  z.object({
    kind: z.literal("editMessage"),
    messageId: z.string(),
    newText: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("deleteMessage"),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal("deleteAllMessagesBy"),
    authorId: z.string(),
  }),
  // Reactions
  z.object({
    kind: z.literal("reactToMessage"),
    messageId: z.string(),
    emoji: z.string().min(1).max(8),
  }),
  z.object({
    kind: z.literal("deleteReaction"),
    messageId: z.string(),
    emoji: z.string().min(1).max(8),
  }),
  z.object({
    kind: z.literal("deleteAllReactions"),
    messageId: z.string(),
  }),
  // Annotations: pin, star
  z.object({
    kind: z.literal("pinMessage"),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal("unpinMessage"),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal("starMessage"),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal("unstarMessage"),
    messageId: z.string(),
  }),
  // Queries/generations (trigger API calls)
  z.object({
    kind: z.literal("summarizeConversation"),
  }),
  z.object({
    kind: z.literal("generateResponse"),
  }),
  z.object({
    kind: z.literal("suggestReplies"),
  }),
  z.object({
    kind: z.literal("roastMe"),
  }),
  z.object({
    kind: z.literal("complimentMe"),
  }),
  // Nicknames (personal — how the viewer sees the other participant's name)
  z.object({
    kind: z.literal("setNickname"),
    authorId: z.string(),
    nickname: z.string().min(1).max(40),
  }),
  z.object({
    kind: z.literal("clearNickname"),
    authorId: z.string(),
  }),
  // Avatar (SHARED public identity — either participant's, no approval gate,
  // same trust model as messages/reactions/shared components)
  z.object({
    kind: z.literal("generateAvatar"),
    prompt: z.string().min(1).max(400),
    // Whose avatar to change. Omitted/self by default; the model may target
    // the OTHER participant explicitly ("make Sam's avatar a robot").
    authorId: z.string().optional(),
  }),
  // Filters
  z.object({
    kind: z.literal("filterByAuthor"),
    authorId: z.string().nullable(),
  }),
]);

export type MessageAction = z.infer<typeof MessageActionSchema>;

// The router's whole output: a plan the app executes.
// - messageActions: content operations (edit, delete, react, etc).
// - themeInstruction: appearance request, delegated to generateSpec.
// - themeMutation: explicit theme operations (reset, randomize).
// - conversationTitle: if set, rename the conversation.
// - clearConversation: if true, delete all messages.
// - reply: one human sentence describing the outcome.
// - feasible: false only when nothing at all could be mapped.
export const PlanSchema = z.object({
  messageActions: z.array(MessageActionSchema).default([]),
  themeInstruction: z.string().nullable().default(null),
  themeMutation: z.enum(["reset", "randomize"]).nullable().default(null),
  conversationTitle: z.string().nullable().default(null),
  clearConversation: z.boolean().default(false),
  reply: z.string().default(""),
  feasible: z.boolean().default(true),
  // True only for genuine ambiguity (multiple plausible interpretations, not
  // just "the model isn't 100% sure"). When true, everything else is empty/
  // null/false and `reply` holds the clarifying question instead of a result.
  needsClarification: z.boolean().default(false),
});

export type Plan = z.infer<typeof PlanSchema>;

export type ValidatePlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

export function validatePlan(candidate: unknown): ValidatePlanResult {
  const result = PlanSchema.safeParse(candidate);
  if (result.success) return { ok: true, plan: result.data };
  const issue = result.error.issues[0];
  const path = issue.path.join(".");
  return { ok: false, error: path ? `${path}: ${issue.message}` : issue.message };
}

// ---------------------------------------------------------------------------
// Router prompt — built from the catalog + live conversation, one source of
// truth. The model resolves message references ("Sam's last message") to ids
// itself; execution re-checks every id exists, so a hallucinated id is skipped,
// never applied.
// ---------------------------------------------------------------------------

export function buildRouterPrompt(): string {
  // Generated from the shared genre catalog rather than hand-written here.
  // The router rejecting a capability that actually exists is this codebase's
  // most-repeated bug ("insert a timer" and "add a tic-tac-toe game" both came
  // back as "Piper can't do that" while the engine could build them), and it
  // happened because this list was a separate copy that had to be remembered
  // whenever a capability shipped. Adding a genre to genres.ts now updates
  // this prompt automatically, and scripts/check-prompts.mjs fails if a genre
  // ever stops being represented here.
  const capabilityLines = GENRE_NAMES.map((name) => `   - ${GENRES[name].routerHint}`);

  return [
    "You are the planner for Piper, an iMessage-style chat app. You read a user instruction, the current chat state, and output a JSON plan — or explain why it can't be done.",
    "",
    "THREE kinds of changes you can make:",
    "",
    "1. APPEARANCE — theme/UI/visual effects/INTERACTIVE WIDGETS via `themeInstruction` (a plain-language request, passed through close to verbatim so the theming engine sees the full intent). This covers the plain theme (colors, fonts, backgrounds, bubble size/shape, density, avatars, timestamps) AND all of the following, every one of which Piper can genuinely build:",
    ...capabilityLines,
    "   ALL of it is routed the same way, INCLUDING requests phrased as games, tools, or \"embedding\" something. Never reject a widget/game/timer/tool/effect request as \"not supported\" or \"no embedding capability\" — that capability exists. This also covers REMOVING or MODIFYING something already added this way (\"delete the tic-tac-toe game\", \"remove the timer\") — the theming engine sees the current state and handles this even though you (the router) don't have visibility into exactly what's currently there; forward it as themeInstruction rather than guessing it doesn't exist. Or explicit theme mutations: `themeMutation: 'reset'` or `'randomize'`. Leave both null only if the request has no appearance part at all.",
    "",
    "2. CONVERSATION — `conversationTitle` to rename, or `clearConversation: true` to delete all messages.",
    "",
    "3. MESSAGE OPERATIONS via `messageActions` — an array of one or more:",
    "   Read: translateMessage",
    "   Write: editMessage, deleteMessage, deleteAllMessagesBy",
    "   Reactions: reactToMessage, deleteReaction, deleteAllReactions",
    "   Annotations: pinMessage, unpinMessage, starMessage, unstarMessage",
    "   Queries: summarizeConversation, generateResponse, suggestReplies, roastMe, complimentMe",
    "   Nicknames (PERSONAL — only changes how YOU see the other person's name, never their real profile, never visible to them): setNickname, clearNickname",
    "   Avatar (SHARED public avatar image — either participant's, no approval needed, same trust model as reactions/shared components): generateAvatar",
    "",
    "MESSAGE ACTION DETAILS:",
    '  - {"kind":"translateMessage","messageId":<id>,"targetLanguage":"French"} — any language.',
    '  - {"kind":"editMessage","messageId":<id>,"newText":<string>} — you write the new text. Examples: "fix my typo", "make it formal".',
    '  - {"kind":"deleteMessage","messageId":<id>} — remove a single message. Examples: "delete my last message", "remove the one that says hello".',
    '  - {"kind":"deleteAllMessagesBy","authorId":<id>} — remove ALL messages from one person. Examples: "delete all my messages", "delete all my texts", "remove all of Sam\'s messages", "delete everything I wrote", "nuke all my messages".',
    '  - {"kind":"reactToMessage","messageId":<id>,"emoji":"👍"} — add a reaction.',
    '  - {"kind":"deleteReaction","messageId":<id>,"emoji":"👍"} — remove one emoji.',
    '  - {"kind":"deleteAllReactions","messageId":<id>} — remove all reactions from a message.',
    '  - {"kind":"pinMessage","messageId":<id>} — pin to top.',
    '  - {"kind":"unpinMessage","messageId":<id>}',
    '  - {"kind":"starMessage","messageId":<id>} — bookmark.',
    '  - {"kind":"unstarMessage","messageId":<id>}',
    '  - {"kind":"summarizeConversation"} — generate a summary.',
    '  - {"kind":"generateResponse"} — AI draft a reply.',
    '  - {"kind":"suggestReplies"} — 3 suggested replies.',
    '  - {"kind":"roastMe"} — a short, playful, lighthearted roast of the current user based on the conversation. Examples: "roast me", "roast me based on this chat".',
    '  - {"kind":"complimentMe"} — a short, warm compliment for the current user based on the conversation. Examples: "compliment me", "say something nice about me", "hype me up".',
    '  - {"kind":"setNickname","authorId":<id>,"nickname":<string>} — from now on, YOU (not them) see that participant\'s name as the nickname everywhere their name is shown. Examples: "call Sam \'Sammy\'", "nickname Sam as Boss". Use the exact authorId from the participants list — never your own.',
    '  - {"kind":"clearNickname","authorId":<id>} — go back to their real name. Examples: "stop calling Sam Sammy", "remove Sam\'s nickname", "use Sam\'s real name again".',
    '  - {"kind":"generateAvatar","prompt":<string>,"authorId":<id, optional>} — generate a new profile picture. Fully open-ended: whatever can be described can be requested — an object, a flag, a logo, a shape, a landmark, on-image text, an abstract idea, a character, a real photo style, anything. Omit authorId (or use the current user\'s own id) for "make MY avatar X". Set authorId to the OTHER participant\'s exact id from the participants list for "make SAM\'s avatar X" / "give Sam a robot avatar" — this is allowed, same as reacting to Sam\'s message or editing the shared theme; there is no approval step. You write the image generation prompt yourself, and the one rule that matters for ANY subject: describe literally and precisely what was asked for, the way you\'d brief a photographer or illustrator — never let the prompt default toward a portrait of a person unless a person/character was actually the request. A vague pass-through of the request\'s own wording ("flag of Japan") tends to drift toward an unrelated human-subject image; a precise description of the actual visual ("the flag of Japan: a red circle centered on a white field") does not. Apply that same precision to whatever the subject actually is — a shape, a landmark, an object, text, a scene — not just to flags. Examples: "make my avatar a cartoon fox", "give Sam a robot avatar", "make my avatar the flag of Japan", "make my avatar a green triangle on a white background", "change Sam\'s profile picture to the Eiffel Tower at sunset". This is a real AI-generated image, distinct from the appearance/theme system — route avatar requests here, never through themeInstruction.',
    "",
    "Resolve message references yourself using the list below. Match by quote, position (\\\"last message\\\", \\\"first message\\\", \\\"second message\\\"), or author. Use the exact id from the list. NEVER invent an id.",
    "",
    "WHEN TO ASK VS WHEN TO JUST DO IT: if you can make a reasonably confident interpretation, DO IT — don't ask for confirmation on things that are merely underspecified but have an obvious best reading (e.g. \"delete my last message\" when there's exactly one obvious last message from the user is NOT ambiguous). Only set `needsClarification: true` for GENUINE ambiguity — where two or more clearly different interpretations are both plausible and picking wrong would do the wrong thing (e.g. \"delete the one about oranges\" when three different messages mention oranges; \"make it look nicer\" with no concrete direction at all; an instruction that could equally mean a message action or a theme change with very different results). When you set needsClarification true: leave messageActions empty, themeInstruction/themeMutation/conversationTitle null, clearConversation false, and put a SPECIFIC question in `reply` (list the actual options where possible, e.g. quote the 3 candidate messages) so the user can answer directly. Never ask a vague \"what do you mean?\" — always ask a concrete, answerable question.",
    "",
    "Output ONLY a JSON object:",
    '{"messageActions":[...],"themeInstruction":<string|null>,"themeMutation":<"reset"|"randomize"|null>,"conversationTitle":<string|null>,"clearConversation":<boolean>,"reply":<string>,"feasible":<boolean>,"needsClarification":<boolean>}',
    "",
    "`reply`: one sentence. If done, say what you did. If not feasible, explain why and suggest alternatives. If needsClarification, ask the specific question.",
    "`feasible`: false only if you produced nothing at all AND aren't asking for clarification. Visual effects, animations, and on-event triggers (confetti, flashes, pulsing, glows, etc.) are ALWAYS achievable via themeInstruction — never mark these infeasible or claim Piper can't do them.",
    "",
    "Return raw JSON only — no markdown.",
  ].join("\n");
}

export function describeConversation(messages: ChatMessage[], users: DisplayUser[], viewerId: string): string {
  const nameFor = (authorId: string) => {
    const u = users.find((x) => x.id === authorId);
    const label = u?.name ?? authorId;
    return authorId === viewerId ? `${label} (the current user / "me")` : label;
  };
  // Actions like deleteAllMessagesBy/filterByAuthor need a real author id, not
  // just a display name — without this list the model has nothing to put in
  // `authorId` but a guess, which fails the database's uuid check.
  const participantLines = users.map(
    (u) => `- authorId=${u.id} | ${u.name}${u.id === viewerId ? ' (the current user / "me")' : ""}`,
  );
  const lines = messages.map((m) => `- id=${m.id} | ${nameFor(m.authorId)}: ${JSON.stringify(m.text)}`);
  return [
    `Participants (use these exact authorId values for deleteAllMessagesBy/filterByAuthor):`,
    participantLines.join("\n"),
    "",
    `Current conversation (oldest first):`,
    lines.join("\n"),
  ].join("\n");
}
