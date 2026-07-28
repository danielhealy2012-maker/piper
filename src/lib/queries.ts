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
