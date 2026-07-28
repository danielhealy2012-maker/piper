import { z } from "zod";

// The registry is the ENTIRE surface a natural-language edit may touch.
// Nothing outside these tokens/slots/components can ever reach the DOM —
// the zod spec (spec.ts) validates against exactly this data.

export const FONT_FAMILIES = ["system", "rounded", "mono", "serif"] as const;
export const DENSITIES = ["compact", "comfortable", "spacious"] as const;
// `wallpaper` selects the BASE layer. "custom" reads wallpaperColor, "gradient"
// reads the gradient* tokens, "image" reads wallpaperImage, "generated" reads
// wallpaperUrl (an AI-generated image — see lib/image.ts and api/image.js).
// wallpaperPattern is an independent overlay that composites on top of
// whichever base is selected.
export const WALLPAPERS = [
  "none",
  "dots",
  "grid",
  "sunset",
  "ocean",
  "charcoal",
  "custom",
  "gradient",
  "image",
  "generated",
] as const;
export const WALLPAPER_IMAGES = [
  "none",
  "mountains",
  "waves",
  "city",
  "forest",
  "desert",
  "aurora",
  "confetti",
  "bokeh",
] as const;
export const WALLPAPER_PATTERNS = ["none", "dots", "grid", "stripes", "checks", "crosshatch"] as const;
export const CORNER_STYLES = ["tight", "soft", "round", "pill"] as const;
export const SEND_BUTTON_STYLES = ["arrow", "plane", "heart", "dot"] as const;
export const BUBBLE_BORDER_STYLES = ["none", "solid", "dashed", "dotted"] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];
export type Density = (typeof DENSITIES)[number];
export type Wallpaper = (typeof WALLPAPERS)[number];
export type WallpaperImage = (typeof WALLPAPER_IMAGES)[number];
export type WallpaperPattern = (typeof WALLPAPER_PATTERNS)[number];
export type CornerStyle = (typeof CORNER_STYLES)[number];
export type SendButtonStyle = (typeof SEND_BUTTON_STYLES)[number];
export type BubbleBorderStyle = (typeof BUBBLE_BORDER_STYLES)[number];

type ThemeTokenDescriptor =
  | { kind: "text"; label: string; maxLength: number }
  | { kind: "color"; label: string }
  | { kind: "number"; label: string; min: number; max: number }
  | { kind: "enum"; label: string; values: readonly string[] }
  | { kind: "boolean"; label: string };

export const THEME_TOKENS: Record<string, ThemeTokenDescriptor> = {
  chatTitle: { kind: "text", label: "Name shown in the conversation header", maxLength: 40 },
  bubbleColorOutgoing: { kind: "color", label: "Bubble color for messages you send" },
  bubbleColorIncoming: { kind: "color", label: "Bubble color for messages you receive" },
  textColorOutgoing: { kind: "color", label: "Text color for messages you send" },
  textColorIncoming: { kind: "color", label: "Text color for messages you receive" },
  accentColor: { kind: "color", label: "Send button, highlights" },
  bubbleScale: { kind: "number", label: "Bubble size scale", min: 0.8, max: 1.6 },
  cornerStyle: { kind: "enum", label: "Bubble corner style", values: CORNER_STYLES },
  sendButtonStyle: { kind: "enum", label: "Send button icon", values: SEND_BUTTON_STYLES },
  fontFamily: { kind: "enum", label: "Font family", values: FONT_FAMILIES },
  density: { kind: "enum", label: "Message row spacing", values: DENSITIES },
  wallpaper: { kind: "enum", label: "Chat background base layer", values: WALLPAPERS },
  wallpaperColor: {
    kind: "color",
    label: 'Solid background color, used only when wallpaper is "custom"',
  },
  gradientFrom: {
    kind: "color",
    label: 'Gradient start color, used only when wallpaper is "gradient"',
  },
  gradientVia: {
    kind: "color",
    label: 'Gradient middle color, used only when wallpaper is "gradient"',
  },
  gradientTo: {
    kind: "color",
    label: 'Gradient end color, used only when wallpaper is "gradient"',
  },
  gradientAngle: {
    kind: "number",
    label: "Gradient direction in degrees (0 = bottom-to-top, 90 = left-to-right)",
    min: 0,
    max: 360,
  },
  wallpaperImage: {
    kind: "enum",
    label: 'Illustrated background scene, used only when wallpaper is "image"',
    values: WALLPAPER_IMAGES,
  },
  wallpaperPattern: {
    kind: "enum",
    label: "Pattern overlaid on top of any background base",
    values: WALLPAPER_PATTERNS,
  },
  patternOpacity: {
    kind: "number",
    label: "How strong the pattern overlay is",
    min: 0,
    max: 1,
  },
  bubbleTail: { kind: "boolean", label: "Little tails on bubbles" },
  bubbleBorderStyle: { kind: "enum", label: "Bubble border style", values: BUBBLE_BORDER_STYLES },
  bubbleBorderWidth: {
    kind: "number",
    label: "Bubble border thickness in pixels",
    min: 0,
    max: 4,
  },
  bubbleBorderColor: { kind: "color", label: "Bubble border color" },
  sentimentTint: { kind: "boolean", label: "Tint incoming messages by mood" },
  showAvatars: { kind: "boolean", label: "Show avatars" },
  showTimestamps: { kind: "boolean", label: "Show timestamps" },
};

export const SLOTS = {
  messageActions: {
    label: "Action buttons attached to a message",
    allow: [
      "TranslateButton",
      "SummarizeButton",
      "CopyButton",
      "PinButton",
      "ReactionBar",
      "ReadReceipt",
    ],
  },
  composerActions: {
    label: "Buttons in the message composer",
    allow: [
      "ToneShifter",
      "ClearButton",
      "VoiceNote",
      "GifPicker",
      "Poll",
      "ScheduledSend",
      "AIReplyDraft",
    ],
  },
  headerActions: {
    label: "Buttons in the conversation header",
    allow: ["SearchBox", "MuteToggle", "ThemeBadge", "VideoCallButton"],
  },
} as const;

export type SlotName = keyof typeof SLOTS;
export const SLOT_NAMES = Object.keys(SLOTS) as SlotName[];

// Component prop schemas. Every component not listed here explicitly takes no props.
export const COMPONENT_PROPS_SCHEMAS = {
  TranslateButton: z.object({
    // Free text, matching the router's translateMessage action — any language
    // name (e.g. "Chinese", "Japanese"), or the sentinel "auto" (non-English
    // -> English, English -> Spanish).
    target: z.string().min(1).max(40).default("auto"),
  }),
  ReactionBar: z.object({
    emojis: z.array(z.string()).max(6).default(["❤️", "👍", "😂", "❗"]),
  }),
  Poll: z.object({
    question: z.string().max(60).default("Lunch today?"),
    options: z.array(z.string()).max(4).default(["Yes", "Can't"]),
  }),
  ToneShifter: z.object({
    tones: z.array(z.enum(["formal", "casual", "warm", "concise"])).default(["formal", "casual"]),
  }),
  ThemeBadge: z.object({
    text: z.string().max(24).default("custom"),
  }),
} as const;

const ALL_COMPONENT_NAMES = [
  ...SLOTS.messageActions.allow,
  ...SLOTS.composerActions.allow,
  ...SLOTS.headerActions.allow,
] as const;

export type ComponentName = (typeof ALL_COMPONENT_NAMES)[number];
export const COMPONENT_NAMES: ComponentName[] = Array.from(new Set(ALL_COMPONENT_NAMES));

const DEFAULT_EMPTY_PROPS_SCHEMA = z.object({}).default({});

export function propsSchemaFor(component: string): z.ZodTypeAny {
  if (component in COMPONENT_PROPS_SCHEMAS) {
    return COMPONENT_PROPS_SCHEMAS[component as keyof typeof COMPONENT_PROPS_SCHEMAS];
  }
  return DEFAULT_EMPTY_PROPS_SCHEMA;
}

export const COMPONENTS: Record<
  ComponentName,
  { slot: SlotName; propsSchema: z.ZodTypeAny }
> = Object.fromEntries(
  COMPONENT_NAMES.map((name) => {
    const slot = (SLOT_NAMES.find((s) => (SLOTS[s].allow as readonly string[]).includes(name)) ??
      "messageActions") as SlotName;
    return [name, { slot, propsSchema: propsSchemaFor(name) }];
  }),
) as Record<ComponentName, { slot: SlotName; propsSchema: z.ZodTypeAny }>;
