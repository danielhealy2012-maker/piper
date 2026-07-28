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

// Events a custom effect can bind to.
export const CUSTOM_EFFECT_EVENTS = ["onMessageReceived", "onMessageSent", "onReaction"] as const;
export type CustomEffectEvent = (typeof CUSTOM_EFFECT_EVENTS)[number];

export const CustomEffectsSchema = z
  .object({
    onMessageReceived: z.string().max(4000).nullable(),
    onMessageSent: z.string().max(4000).nullable(),
    onReaction: z.string().max(4000).nullable(),
  })
  .partial()
  .default({});

export type CustomCss = z.infer<typeof CustomCssSchema>;
export type CustomEffects = z.infer<typeof CustomEffectsSchema>;

export const SpecSchema = z.object({
  version: z.literal(1),
  theme: ThemeSchema,
  slots: SlotsSchema,
  // Raw CSS text injected in a <style> tag — the only way to express
  // @keyframes/animations, which inline style objects can't carry.
  customCSSText: z.string().max(4000).default(""),
  customCSS: CustomCssSchema,
  customEffects: CustomEffectsSchema,
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
