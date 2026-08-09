import type { ChatMessage } from "./types";
import type { DisplayUser } from "./backend";
import { apiPost } from "./api";
import { errorMessage } from "./errors";

export interface SummarizeResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

export async function summarizeConversation(
  messages: ChatMessage[],
  users: DisplayUser[],
): Promise<SummarizeResult> {
  try {
    const res = await apiPost("/api/summarize", {
      messages: messages.map((m) => ({ authorId: m.authorId, text: m.text, time: m.time })),
      users,
    });
    if (!res.ok) {
      return { ok: false, error: "API error" };
    }
    const data = (await res.json()) as { summary?: string; error?: string };
    return data.summary ? { ok: true, summary: data.summary } : { ok: false, error: data.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface GenerateResponseResult {
  ok: boolean;
  response?: string;
  error?: string;
}

export async function generateResponse(
  messages: ChatMessage[],
  users: DisplayUser[],
): Promise<GenerateResponseResult> {
  try {
    const res = await apiPost("/api/generate-response", {
      messages: messages.map((m) => ({ authorId: m.authorId, text: m.text, time: m.time })),
      users,
    });
    if (!res.ok) {
      return { ok: false, error: "API error" };
    }
    const data = (await res.json()) as { response?: string; error?: string };
    return data.response ? { ok: true, response: data.response } : { ok: false, error: data.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface SuggestRepliesResult {
  ok: boolean;
  replies?: string[];
  error?: string;
}

export async function suggestReplies(
  messages: ChatMessage[],
  users: DisplayUser[],
): Promise<SuggestRepliesResult> {
  try {
    const res = await apiPost("/api/suggest-replies", {
      messages: messages.map((m) => ({ authorId: m.authorId, text: m.text, time: m.time })),
      users,
    });
    if (!res.ok) {
      return { ok: false, error: "API error" };
    }
    const data = (await res.json()) as { replies?: string[]; error?: string };
    return data.replies ? { ok: true, replies: data.replies } : { ok: false, error: data.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface GenerateAvatarResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** Phase 2 #11. Server-generated and server-written (api/avatar.js) — the
 *  client never sets profiles.avatar_url directly, see that file for why. */
export async function generateAvatar(prompt: string): Promise<GenerateAvatarResult> {
  try {
    const res = await apiPost("/api/avatar", { prompt });
    if (!res.ok) {
      if (res.status === 503) return { ok: false, error: "not available locally" };
      return { ok: false, error: "API error" };
    }
    const data = (await res.json()) as { url?: string; error?: string };
    return data.url ? { ok: true, url: data.url } : { ok: false, error: data.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface RoastOrComplimentResult {
  ok: boolean;
  message?: string;
  error?: string;
}

// One endpoint for both directions — same conversation context, only the
// tone of the system prompt differs. `viewerId` picks WHO gets roasted/
// complimented: always the person asking, never the other participant,
// since "roast me" said by either person about the other would be a very
// different (and much riskier) feature.
export async function roastOrCompliment(
  messages: ChatMessage[],
  users: DisplayUser[],
  viewerId: string,
  tone: "roast" | "compliment",
): Promise<RoastOrComplimentResult> {
  try {
    const res = await apiPost("/api/roast-or-compliment", {
      messages: messages.map((m) => ({ authorId: m.authorId, text: m.text, time: m.time })),
      users,
      viewerId,
      tone,
    });
    if (!res.ok) {
      return { ok: false, error: "API error" };
    }
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message ? { ok: true, message: data.message } : { ok: false, error: data.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
