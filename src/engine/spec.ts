import { z } from "zod";
import {
  BUBBLE_BORDER_STYLES,
  CORNER_STYLES,
  DENSITIES,
  FONT_FAMILIES,
  SEND_BUTTON_STYLES,
  SLOT_NAMES,
  SLOTS,
  WALLPAPERS,
  WALLPAPER_IMAGES,
  WALLPAPER_PATTERNS,
  propsSchemaFor,
} from "./registry";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const hex = () => z.string().regex(HEX_RE, "must be a hex color");

// wallpaperUrl is never set by the model directly (it's not in THEME_TOKENS,
// so the model's prompt never even mentions it) — only the orchestrator sets
// it, after a real image generation call succeeds. This validator is the
// backstop against a corrupted/tampered spec (e.g. hand-edited localStorage)
// injecting an arbitrary external URL: it must be an https URL under this
// project's own Supabase Storage "backgrounds" bucket, or empty.
const SUPABASE_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? "";
const STORAGE_PREFIX = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/backgrounds/` : null;
const wallpaperUrlSchema = z
  .string()
  .max(500)
  .refine((v) => v === "" || (v.startsWith("https://") && (!STORAGE_PREFIX || v.startsWith(STORAGE_PREFIX))), {
    message: "wallpaperUrl must be a Supabase Storage public URL",
  })
  // Defaulted, not required: the model is never told this field exists (it's
  // excluded from THEME_TOKENS on purpose), so its responses legitimately
  // omit it. Without a default, that omission failed validation on every
  // single "generated" request and forced an unnecessary escalation retry.
  .default("");

export const ThemeSchema = z.object({
  chatTitle: z.string().max(40),
  bubbleColorOutgoing: hex(),
  bubbleColorIncoming: hex(),
  textColorOutgoing: hex(),
  textColorIncoming: hex(),
  accentColor: hex(),
  bubbleScale: z.number().min(0.8).max(1.6),
  cornerStyle: z.enum(CORNER_STYLES),
  sendButtonStyle: z.enum(SEND_BUTTON_STYLES),
  fontFamily: z.enum(FONT_FAMILIES),
  density: z.enum(DENSITIES),
  wallpaper: z.enum(WALLPAPERS),
  wallpaperColor: hex(),
  gradientFrom: hex(),
  gradientVia: hex(),
  gradientTo: hex(),
  gradientAngle: z.number().min(0).max(360),
  wallpaperImage: z.enum(WALLPAPER_IMAGES),
  wallpaperUrl: wallpaperUrlSchema,
  wallpaperPattern: z.enum(WALLPAPER_PATTERNS),
  patternOpacity: z.number().min(0).max(1),
  bubbleTail: z.boolean(),
  bubbleBorderStyle: z.enum(BUBBLE_BORDER_STYLES),
  bubbleBorderWidth: z.number().min(0).max(4),
  bubbleBorderColor: hex(),
  sentimentTint: z.boolean(),
  showAvatars: z.boolean(),
  showTimestamps: z.boolean(),
});

export type Theme = z.infer<typeof ThemeSchema>;

// This is the ONLY validator standing between free-form model/stub output and the DOM.
// It runs on stub output, on model output, AND on specs re-hydrated from localStorage.
export const ActionSchema = z
  .object({
    component: z.string(),
    on: z.enum(["incoming", "outgoing", "all"]).default("all"),
    props: z.record(z.unknown()).optional(),
  })
  .superRefine((action, ctx) => {
    if (!isKnownComponent(action.component)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown component "${action.component}"`,
        path: ["component"],
      });
      return;
    }
    const schema = propsSchemaFor(action.component);
    const result = schema.safeParse(action.props ?? {});
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid props for ${action.component}: ${result.error.issues[0]?.message ?? "invalid"}`,
        path: ["props"],
      });
    }
  });

function isKnownComponent(name: string): boolean {
  return SLOT_NAMES.some((slot) => (SLOTS[slot].allow as readonly string[]).includes(name));
}

export type Action = z.infer<typeof ActionSchema>;

function slotSchema(slotName: (typeof SLOT_NAMES)[number]) {
  return z.array(ActionSchema).default([]).superRefine((actions, ctx) => {
    const allow: readonly string[] = SLOTS[slotName].allow;
    actions.forEach((action, i) => {
      if (!allow.includes(action.component)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${action.component}" is not allowed in ${slotName}`,
          path: [i, "component"],
        });
      }
    });
  });
}

export const SlotsSchema = z.object({
  messageActions: slotSchema("messageActions"),
  composerActions: slotSchema("composerActions"),
  headerActions: slotSchema("headerActions"),
});

export type Slots = z.infer<typeof SlotsSchema>;

// ---------------------------------------------------------------------------
// Escape hatches — unbounded styling/behavior for requests the token registry
// doesn't anticipate ("cloud-shaped bubbles", "confetti pop on receive").
// These are intentionally validated only for SHAPE, not content:
//   - customCSS/customCSSText render as React style objects / a <style> tag,
//     which can't execute script — worst case is ugly or broken CSS.
//   - customEffects are JS source compiled with `new Function` and run in a
//     try/catch against a handed-in container node. A broken or hostile
//     effect can misbehave inside the chat UI, but can't do anything a
//     browser tab couldn't already do to itself. Accepted tradeoff for a
//     personal project — see conversation: user explicitly waived this.
// ---------------------------------------------------------------------------

// Zones a custom style block can attach to.
export const CUSTOM_CSS_ZONES = ["bubbleOutgoing", "bubbleIncoming", "background", "header"] as const;
export type CustomCssZone = (typeof CUSTOM_CSS_ZONES)[number];

const cssPropsSchema = z.record(z.string()).default({});

export const CustomCssSchema = z
  .object({
    bubbleOutgoing: cssPropsSchema,
    bubbleIncoming: cssPropsSchema,
    background: cssPropsSchema,
    header: cssPropsSchema,
  })
  .partial()
  .default({});

// Events a custom effect can bind to. onLoad is different in kind from the
// other three: it fires once (when the spec is applied / the chat mounts),
// not per-message — the intended use is setting up its OWN infinite CSS
// animation so it keeps running without being re-triggered. Added after a
// real gap: a request for a "continuously slithering" decoration got mapped
// onto onMessageReceived (a one-shot, message-triggered effect) because
// that's all that existed, so it only ever appeared right after an incoming
// message — never persistently, which is what was actually asked for.
export const CUSTOM_EFFECT_EVENTS = ["onLoad", "onMessageReceived", "onMessageSent", "onReaction"] as const;
export type CustomEffectEvent = (typeof CUSTOM_EFFECT_EVENTS)[number];

export const CustomEffectsSchema = z
  .object({
    onLoad: z.string().max(4000).nullable(),
    onMessageReceived: z.string().max(4000).nullable(),
    onMessageSent: z.string().max(4000).nullable(),
    onReaction: z.string().max(4000).nullable(),
  })
  .partial()
  .default({});

export type CustomCss = z.infer<typeof CustomCssSchema>;
export type CustomEffects = z.infer<typeof CustomEffectsSchema>;

// Net-new interactive UI, one tier further than customCSS/customEffects: a
// whole React component, not just a style or a one-shot handler. Same
// unvalidated-content trust posture (compiled and rendered, never inspected
// for safety) but a materially different failure mode — a bad component can
// misbehave for as long as it stays mounted (a leaked interval, a bad render
// loop), not just once. The `id` is what makes removal reliable: the client
// always offers a direct, model-independent "remove this" affordance (see
// CustomComponentRenderer.tsx) rather than depending on a future prompt
// correctly identifying which component to drop.
export const CUSTOM_COMPONENT_SLOTS = ["composerActions", "headerActions", "standalone"] as const;
export type CustomComponentSlot = (typeof CUSTOM_COMPONENT_SLOTS)[number];

// Which of the two scope models a component belongs to.
//
// "personal" (the default, and the original behavior) lives in the spec, in
// `member_theme`, owner-only by RLS — a calculator or a countdown timer that
// only concerns you.
//
// "shared" lives in the conversation-level `shared_components` table and is
// synced to both people via Realtime, with a `sharedState` blob alongside it.
// This is the only way a two-player game, a shared to-do list or a live poll
// can work at all: a personal-scoped board renders for one person, and its
// state is local `useState` inside the compiled component, so neither the
// board nor the moves reach the other person.
//
// Defaulted rather than required: every spec written before this existed
// omits it, and those components were all personal.
export const CUSTOM_COMPONENT_SCOPES = ["personal", "shared"] as const;
export type CustomComponentScope = (typeof CUSTOM_COMPONENT_SCOPES)[number];

export const CustomComponentSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  slot: z.enum(CUSTOM_COMPONENT_SLOTS),
  // 6000, raised from 3000 after measuring real output: a countdown timer is
  // ~500 chars, but anything two-player is structurally bigger because it
  // carries a state shape, turn logic and player identity. Measured against
  // the live model, tic-tac-toe came back at 3090, a word game at 3503, a
  // shared whiteboard at 3596 and a calculator at 3860 — so the old cap
  // rejected most of the interesting widgets, including three of the
  // approved shared-state features, and surfaced as the unhelpful "the model
  // couldn't produce a valid change".
  //
  // Not raised further because of a real coupling: the whole spec is echoed
  // back on every request, so `max` x the 5-component limit has to fit inside
  // /api/generate's max_tokens with room to spare, or the response truncates
  // mid-JSON — which is its own previously-fixed bug. 5 x 6000 chars is
  // ~7.5k tokens, which is why max_tokens went to 16000 alongside this.
  code: z.string().min(1).max(6000),
  scope: z.enum(CUSTOM_COMPONENT_SCOPES).default("personal"),
});
export type CustomComponent = z.infer<typeof CustomComponentSchema>;

export const SpecSchema = z.object({
  version: z.literal(1),
  theme: ThemeSchema,
  slots: SlotsSchema,
  // Raw CSS text injected in a <style> tag — the only way to express
  // @keyframes/animations, which inline style objects can't carry.
  customCSSText: z.string().max(4000).default(""),
  customCSS: CustomCssSchema,
  customEffects: CustomEffectsSchema,
  // Capped at 5: these are re-sent as full source in every theme-generation
  // request (same as customCSS/customEffects), so this bounds both prompt
  // cost and how many independently-misbehaving widgets can accumulate.
  customComponents: z.array(CustomComponentSchema).max(5).default([]),
});

export type Spec = z.infer<typeof SpecSchema>;

export const DEFAULT_SPEC: Spec = {
  version: 1,
  theme: {
    chatTitle: "Sam Ortega",
    bubbleColorOutgoing: "#0a84ff",
    bubbleColorIncoming: "#e9e9eb",
    textColorOutgoing: "#ffffff",
    textColorIncoming: "#111111",
    accentColor: "#0a84ff",
    bubbleScale: 1.0,
    cornerStyle: "round",
    sendButtonStyle: "arrow",
    fontFamily: "system",
    density: "comfortable",
    wallpaper: "none",
    wallpaperColor: "#ffffff",
    gradientFrom: "#ff9a56",
    gradientVia: "#ff6a88",
    gradientTo: "#a86bd8",
    gradientAngle: 160,
    wallpaperImage: "none",
    wallpaperUrl: "",
    wallpaperPattern: "none",
    patternOpacity: 0.15,
    bubbleTail: false,
    bubbleBorderStyle: "none",
    bubbleBorderWidth: 0,
    bubbleBorderColor: "#111111",
    sentimentTint: false,
    showAvatars: true,
    showTimestamps: true,
  },
  slots: {
    messageActions: [],
    composerActions: [],
    headerActions: [],
  },
  customCSSText: "",
  customCSS: {},
  customEffects: {},
  customComponents: [],
};

export type ValidateResult = { ok: true; spec: Spec } | { ok: false; error: string };

export function validateSpec(candidate: unknown): ValidateResult {
  const result = SpecSchema.safeParse(candidate);
  if (result.success) {
    return { ok: true, spec: result.data };
  }
  const issue = result.error.issues[0];
  const path = issue.path.join(".");
  const error = path ? `${path}: ${issue.message}` : issue.message;
  return { ok: false, error };
}

// Sorts object keys recursively so two structurally-identical specs compare equal
// even if an action's free-form `props` came back with keys in a different order
// (props are a z.record, so key order isn't normalized by the schema like the
// rest of the spec's fields are).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function specsEqual(a: Spec, b: Spec): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
