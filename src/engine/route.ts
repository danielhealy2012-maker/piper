import type { ChatMessage } from "../lib/types";
import type { DisplayUser } from "../lib/backend";
import {
  buildRouterPrompt,
  describeConversation,
  validatePlan,
  type Plan,
} from "./actions";
import { extractJson } from "./json";
import { apiPost } from "../lib/api";

export type RouteResult =
  | { status: "ok"; plan: Plan }
  | { status: "invalid"; error: string }
  | { status: "unavailable" };

// Same same-origin proxy pattern as callModel(): the key stays server-side.
export async function routeInstruction(
  instruction: string,
  messages: ChatMessage[],
  users: DisplayUser[],
  viewerId: string,
  history?: string | null,
): Promise<RouteResult> {
  let res: Response;
  try {
    res = await apiPost("/api/route", {
      system: buildRouterPrompt(),
      instruction,
      conversation: describeConversation(messages, users, viewerId),
      history: history ?? null,
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!res.ok) return { status: "unavailable" };

  const data = (await res.json()) as { raw: string };
  let candidate: unknown;
  try {
    candidate = extractJson(data.raw);
  } catch {
    return { status: "invalid", error: "router response was not valid JSON" };
  }
  const validated = validatePlan(candidate);
  if (!validated.ok) return { status: "invalid", error: validated.error };
  return { status: "ok", plan: validated.plan };
}
