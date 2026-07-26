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
    const next = reactions.includes(emoji)
      ? reactions.filter((e) => e !== emoji)
      : [...reactions, emoji];
    return { ...m, reactions: next };
  });
}

export function applyDeleteReaction(messages: ChatMessage[], id: string, emoji: string): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, reactions: (m.reactions ?? []).filter((e) => e !== emoji) } : m));
}

export function applyDeleteAllReactions(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, reactions: [] } : m));
}

export function applyDeleteAllMessagesBy(messages: ChatMessage[], authorId: string): ChatMessage[] {
  return messages.filter((m) => m.authorId !== authorId);
}

// Pin, star, filter: these are UI-state operations, not message-list mutations.
// Keeping them here as no-ops since they're handled in Workspace state.
export function applyPinMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages;
}

export function applyUnpinMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages;
}

export function applyStarMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages;
}

export function applyUnstarMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages;
}

export function applyFilterByAuthor(messages: ChatMessage[], authorId: string | null): ChatMessage[] {
  return messages;
}

// Query/generation actions (summarize, generate, suggest) are no-ops here
// but trigger API calls in the orchestrator.
export function applySummarizeConversation(messages: ChatMessage[]): ChatMessage[] {
  return messages;
}

export function applyGenerateResponse(messages: ChatMessage[]): ChatMessage[] {
  return messages;
}

export function applySuggestReplies(messages: ChatMessage[]): ChatMessage[] {
  return messages;
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
    "You are the planner for Piper, an iMessage-style chat app. You read a user instruction, the current chat state, and output a JSON plan — or explain why it can't be done.",
    "",
    "THREE kinds of changes you can make:",
    "",
    "1. APPEARANCE — theme/UI via `themeInstruction` (a plain-language request, e.g. 'green bubbles', 'dark mode'). Or explicit theme mutations: `themeMutation: 'reset'` or `'randomize'`. Leave both null if the request has no appearance part.",
    "",
    "2. CONVERSATION — `conversationTitle` to rename, or `clearConversation: true` to delete all messages.",
    "",
    "3. MESSAGE OPERATIONS via `messageActions` — an array of one or more:",
    "   Read: translateMessage",
    "   Write: editMessage, deleteMessage, deleteAllMessagesBy",
    "   Reactions: reactToMessage, deleteReaction, deleteAllReactions",
    "   Annotations: pinMessage, unpinMessage, starMessage, unstarMessage",
    "   Queries: summarizeConversation, generateResponse, suggestReplies",
    "   Filters: filterByAuthor",
    "",
    "MESSAGE ACTION DETAILS:",
    '  - {"kind":"translateMessage","messageId":<id>,"targetLanguage":"French"} — any language.',
    '  - {"kind":"editMessage","messageId":<id>,"newText":<string>} — you write the new text. Examples: "fix my typo", "make it formal".',
    '  - {"kind":"deleteMessage","messageId":<id>} — remove any message.',
    '  - {"kind":"deleteAllMessagesBy","authorId":<id>} — remove all messages from one person.',
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
    '  - {"kind":"filterByAuthor","authorId":"<id or null>"} — show only one person\'s messages (or null to clear).',
    "",
    "Resolve message references yourself using the list below. Match by quote, position (\\\"last message\\\", \\\"first message\\\", \\\"second message\\\"), or author. Use the exact id from the list. NEVER invent an id. If you can't identify which message, add no action and say so in `reply`.",
    "",
    "Output ONLY a JSON object:",
    '{"messageActions":[...],"themeInstruction":<string|null>,"themeMutation":<"reset"|"randomize"|null>,"conversationTitle":<string|null>,"clearConversation":<boolean>,"reply":<string>,"feasible":<boolean>}',
    "",
    "`reply`: one sentence. If done, say what you did. If not, explain why and suggest alternatives.",
    "`feasible`: false only if you produced nothing at all.",
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
  const lines = messages.map((m) => `- id=${m.id} | ${nameFor(m.authorId)}: ${JSON.stringify(m.text)}`);
  return `Current conversation (oldest first):\n${lines.join("\n")}`;
}
