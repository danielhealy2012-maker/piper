import { apiPost } from "../lib/api";

export type TranslateResult =
  | { ok: true; text: string; sameLanguage: boolean }
  | { ok: false; error: string };

// Same pattern as callModel() in generate.ts: same-origin /api/translate proxy,
// so the Anthropic key never reaches the browser. `target` is a free-text
// language name ("French", "Japanese", …) or the sentinel "auto".
export async function translateText(text: string, target: string): Promise<TranslateResult> {
  let res: Response;
  try {
    res = await apiPost("/api/translate", { text, target });
  } catch {
    return { ok: false, error: "network error" };
  }
  if (res.status === 503) {
    return { ok: false, error: "no API key configured" };
  }
  if (!res.ok) {
    return { ok: false, error: "translation unavailable" };
  }
  const data = (await res.json()) as { translation?: string; sameLanguage?: boolean };
  // sameLanguage=true means the text was already in the requested language, so
  // there is nothing to show — the caller surfaces "already in X" instead.
  if (data.sameLanguage) {
    return { ok: true, text: "", sameLanguage: true };
  }
  if (!data.translation) {
    return { ok: false, error: "empty response" };
  }
  return { ok: true, text: data.translation, sameLanguage: false };
}
