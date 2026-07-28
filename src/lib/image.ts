import { apiPost } from "./api";
import { errorMessage } from "./errors";

export type GenerateImageResult = { ok: true; url: string } | { ok: false; error: string };

/** Calls /api/image with a text prompt; the server checks a cache by prompt
 *  hash before spending a real generation call (see api/image.js). */
export async function generateBackgroundImage(prompt: string): Promise<GenerateImageResult> {
  try {
    const res = await apiPost("/api/image", { prompt });
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !data.url) {
      return { ok: false, error: data.error ?? "image generation failed" };
    }
    return { ok: true, url: data.url };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
