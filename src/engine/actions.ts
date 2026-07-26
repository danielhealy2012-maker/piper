import { z } from "zod";
import type { ChatMessage } from "../lib/types";
import type { DisplayUser } from "../lib/backend";

// ---------------------------------------------------------------------------
// The action catalog. This is the bounded vocabulary the router may choose
// from — the message-content analogue of the theme registry. The model decides
// WHICH actions and fills their parameters; the pure appliers below are the
// only code that mutates the conversation, so nothing the model returns can
// reach the DOM without passing through a typed, validated executor.
// ---------------------------------------------------------------------------

export const MessageActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("translateMessage"),
    messageId: z.string(),
    // Free-text so translation is language-agnostic ("French", "Japanese", ...).
    targetLanguage: z.string().min(1).max(40),
  }),
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
    kind: z.literal("reactToMessage"),
    messageId: z.string(),
    emoji: z.string().min(1).max(8),
  }),
]);

export type MessageAction = z.infer<typeof MessageActionSchema>;

// The router's whole output: a plan the app executes.
// - messageActions: content operations to apply.
// - themeInstruction: the appearance part of the request, delegated verbatim to
//   the existing theme engine (generateSpec) so we reuse all its validated
//   token logic rather than re-teaching the router 24 tokens of color math.
// - reply: one human sentence — a summary when things are done, or a "can't do
//   that because… try…" when they aren't.
// - feasible: false only when nothing at all could be mapped.
export const PlanSchema = z.object({
  messageActions: z.array(MessageActionSchema).default([]),
  themeInstruction: z.string().nullable().default(null),
  reply: z.string().default(""),
  feasible: z.boolean().default(true),
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
// Pure appliers. Each takes the message list and returns a new one — no
// mutation, so snapshotting for undo is a shallow copy. translateMessage is NOT
// here because it needs a network call; the orchestrator handles that one.
// ---------------------------------------------------------------------------

export function applyEdit(messages: ChatMessage[], id: string, newText: string): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, text: newText } : m));
}

export function applyDelete(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.filter((m) => m.id !== id);
}

export function applyReaction(messages: ChatMessage[], id: string, emoji: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== id) return m;
    const reactions = m.reactions ?? [];
    // Toggle: same emoji twice removes it, so "react with 👍" is reversible.
    const next = reactions.includes(emoji)
      ? reactions.filter((e) => e !== emoji)
      : [...reactions, emoji];
    return { ...m, reactions: next };
  });
}

export function messageExists(messages: ChatMessage[], id: string): boolean {
  return messages.some((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// Router prompt — built from the catalog + live conversation, one source of
// truth. The model resolves message references ("Sam's last message") to ids
// itself; execution re-checks every id exists, so a hallucinated id is skipped,
// never applied.
// ---------------------------------------------------------------------------

export function buildRouterPrompt(): string {
  return [
    "You are the planner for Piper, an iMessage-style chat demo. You read a user instruction plus the current chat state and output a JSON plan describing exactly what to do — or explain why it can't be done.",
    "",
    "You can do two kinds of things:",
    "",
    "1. APPEARANCE / UI changes — bubble colors, text colors, fonts, backgrounds (solid colors, gradients, illustrated scenes: mountains/waves/city/forest/desert/aurora/confetti/bokeh, and patterns), density, tails, avatars, timestamps, the send-button icon, and adding/removing buttons (translate, poll, voice note, GIF, reactions, read receipts, search, mute, video call, etc.). Do NOT compute these yourself. Put the appearance part of the request, in plain words, into `themeInstruction`. If the request has no appearance part, set themeInstruction to null.",
    "",
    "2. MESSAGE operations on the conversation shown below, via `messageActions`:",
    '   - {"kind":"translateMessage","messageId":<id>,"targetLanguage":<language name, e.g. "French">} — translate one message into ANY language.',
    '   - {"kind":"editMessage","messageId":<id>,"newText":<string>} — replace a message\'s text. If the user asks to rephrase/reword/make it formal/etc., YOU write the new wording and put it in newText.',
    '   - {"kind":"deleteMessage","messageId":<id>} — remove a message.',
    '   - {"kind":"reactToMessage","messageId":<id>,"emoji":<single emoji>} — add an emoji reaction.',
    "",
    "Resolve references to messages yourself using the list below — by quote (\"the one that says grab dinner\"), by position (\"the last message\", \"my first message\"), or by author. Use the exact id from the list. NEVER invent an id. If you can't identify which message is meant, add no action for it and say so in `reply`.",
    "",
    "Output ONLY a JSON object of this shape:",
    '{"messageActions":[...],"themeInstruction":<string|null>,"reply":<string>,"feasible":<boolean>}',
    "",
    "`reply`: one friendly sentence. If everything asked is doable, briefly say what you're doing. If some or all of it is NOT possible in Piper (e.g. play a sound, make a real phone call, send to a real person, generate a photograph, attach a file), do the parts you can and, for the parts you can't, explain plainly why and suggest the closest thing Piper CAN do.",
    "`feasible`: set false ONLY when you produced no messageActions AND themeInstruction is null (nothing at all could be done).",
    "",
    "Return raw JSON only — no markdown, no commentary outside the JSON.",
  ].join("\n");
}

export function describeConversation(messages: ChatMessage[], users: DisplayUser[], viewerId: string): string {
  const nameFor = (authorId: string) => {
    const u = users.find((x) => x.id === authorId);
    const label = u?.name ?? authorId;
    return authorId === viewerId ? `${label} (the current user / "me")` : label;
  };
  const lines = messages.map((m) => `- id=${m.id} | ${nameFor(m.authorId)}: ${JSON.stringify(m.text)}`);
  return `Current conversation (oldest first):\n${lines.join("\n")}`;
}
