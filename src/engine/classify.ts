// ---------------------------------------------------------------------------
// Stage 1 of theme generation: a small, cheap model call that decides WHICH
// mechanisms a request needs, so stage 2 (buildSystemPrompt) can send only
// those instructions instead of every mechanism's instructions at once.
//
// Why this exists: the single mega-prompt was measurably straining. Three real
// bugs — the wrong escape hatch being picked, output truncating mid-JSON, and
// the router rejecting capabilities it had lost track of — all trace back to
// one model call holding every mechanism simultaneously. Splitting intent
// (cheap, tiny input) from execution (focused, only the relevant blocks) is
// the fix, and it's what makes the Phase 2 capability list addable without
// making the prompt worse each time.
//
// Deliberately sees ONLY the instruction, not the spec: this is a question
// about what the user is asking for, not about current state. (State does get
// folded in separately — see genresPresentInSpec below.)
// ---------------------------------------------------------------------------
import { apiPost } from "../lib/api";
import { GENRES, GENRE_NAMES, expandGenres, isGenre, type Genre } from "./genres";
import { extractJson } from "./json";
import type { Spec } from "./spec";

export function buildClassifierPrompt(): string {
  const genreLines = GENRE_NAMES.map((name) => `- "${name}": ${GENRES[name].classifierHint}`);
  return [
    "You are the request classifier for Piper, an iMessage-style chat app whose appearance and behavior users reshape by typing instructions.",
    "Your ONLY job is to decide which mechanisms the instruction needs. You do not fulfil the request, write any code, or describe a design.",
    "",
    "Piper always has a fixed set of theme TOKENS (bubble colors, text colors, accent color, bubble size, corner style, send button style, font family, density, avatars/timestamps on or off, bubble tails, borders, and a background made of solid colors, gradients, 8 bundled illustrated scenes, and pattern overlays). Anything expressible with those tokens alone needs NO flags at all.",
    "",
    "Beyond the tokens there are these mechanisms. Return the flag for each one the instruction genuinely needs:",
    ...genreLines,
    "",
    "Rules:",
    "- Return an EMPTY array when the request is fully covered by the plain theme tokens listed above (e.g. \"make my bubbles green\", \"dark background\", \"bigger text\", \"hide timestamps\", \"use a serif font\", \"blue to purple gradient\").",
    "- Return MORE than one flag when a request genuinely spans mechanisms (e.g. \"glowing bubbles that pulse\" is customCSS + animation; \"a snake that slithers around and confetti when I get a message\" is ambientEffect + reactiveEffect).",
    "- Be accurate rather than generous, but when a request is truly borderline, include the flag — a missing flag means the mechanism's instructions are withheld from the next stage, which is worse than one extra block of context.",
    "- Judge by what the request NEEDS, not by the words used. \"Make it feel alive\" with no further detail is still just tokens; \"add a scoreboard we can both click\" is an interactiveComponent even though it never says \"widget\".",
    "",
    `Output ONLY a JSON object: {"genres": [<zero or more of: ${GENRE_NAMES.map((n) => `"${n}"`).join(", ")}>]}`,
    "No other text, no explanation, no markdown.",
  ].join("\n");
}

/**
 * Returns the genres this instruction needs, or null if the classifier was
 * unavailable/unparseable. null is the GRACEFUL DEGRADATION signal — the
 * caller falls back to the full every-mechanism prompt rather than failing,
 * since this is an accuracy and focus improvement, not a hard dependency.
 */
export async function classifyInstruction(instruction: string): Promise<Set<Genre> | null> {
  let res: Response;
  try {
    res = await apiPost("/api/classify", {
      system: buildClassifierPrompt(),
      instruction,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  try {
    const data = (await res.json()) as { raw: string };
    const parsed = extractJson(data.raw);
    const raw = (parsed as { genres?: unknown }).genres;
    if (!Array.isArray(raw)) return null;
    return expandGenres(raw.filter(isGenre));
  } catch {
    return null;
  }
}

/**
 * Genres the CURRENT spec already uses.
 *
 * Unioned into whatever the classifier returns, because the specialist is
 * required to echo the whole spec back faithfully and can only do that for
 * mechanisms it has been told about. Without this, "make the background blue"
 * against a spec holding a tic-tac-toe game would classify as token-only, and
 * the model would be asked to reproduce `customComponents` source it was never
 * given the contract for — the likeliest outcome being that it quietly drops
 * the game.
 */
export function genresPresentInSpec(spec: Spec): Set<Genre> {
  const present = new Set<Genre>();
  const css = spec.customCSS ?? {};
  if (Object.values(css).some((zone) => zone && Object.keys(zone).length > 0)) present.add("customCSS");
  if (spec.customCSSText) present.add("animation");
  const effects = spec.customEffects ?? {};
  if (effects.onLoad) present.add("ambientEffect");
  if (effects.onMessageReceived || effects.onMessageSent || effects.onReaction) present.add("reactiveEffect");
  if (spec.customComponents.length > 0) present.add("interactiveComponent");
  // A shared component in play means the next instruction could be about it
  // ("make the board bigger"), and rewriting one without the shared-state
  // contract is how a working game gets turned back into a personal one that
  // only its author can see.
  if (spec.customComponents.some((c) => c.scope === "shared")) present.add("sharedState");
  return expandGenres(present);
}
