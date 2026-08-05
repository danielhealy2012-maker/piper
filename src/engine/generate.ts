import {
  COMPONENTS,
  SLOT_NAMES,
  SLOTS,
  THEME_TOKENS,
  propsSchemaFor,
  type ComponentName,
} from "./registry";
import { DEFAULT_SPEC, specsEqual, validateSpec, type Action, type Spec } from "./spec";
import { enforceLegibility } from "./legibility";
import { apiPost } from "../lib/api";
import { generateBackgroundImage } from "../lib/image";

export const ESCALATION_MODEL = "claude-opus-4-8";

// ---------------------------------------------------------------------------
// Rung 1: free, deterministic keyword stub.
// ---------------------------------------------------------------------------

const COLOR_MAP: Record<string, string> = {
  red: "#ff3b30",
  orange: "#ff9500",
  yellow: "#ffcc00",
  green: "#34c759",
  teal: "#30b0c7",
  blue: "#0a84ff",
  indigo: "#5e5ce6",
  purple: "#af52de",
  pink: "#ff2d55",
  brown: "#a2845e",
  gray: "#8e8e93",
  grey: "#8e8e93",
  black: "#1c1c1e",
  white: "#ffffff",
};

// Shared between draft() (applying a title change) and residualContentWords()
// (stripping free-text titles so they don't false-trigger the escalation gate).
const TITLE_RE =
  /(?:\bcall (?:it|them)|\brename(?: the chat)?(?: to)?|\bset (?:the )?(?:chat )?title(?: to)?|\bname (?:the chat|it)(?: to)?)\s+["']?([^"']{1,40}?)["']?\s*$/i;

function hasIncomingWord(lower: string): boolean {
  return /\b(their|incoming|other|friend'?s|received)\b/.test(lower);
}

interface ColorHit {
  word: string;
  index: number;
}

// Every color mention, in the order it appears in the SENTENCE. The old version
// iterated COLOR_MAP's keys instead, so "background white with blue bubbles"
// returned "blue" purely because blue sits earlier in the map — the classic
// source of "why did it color the wrong thing".
function findColorWords(text: string): ColorHit[] {
  const hits: ColorHit[] = [];
  for (const name of Object.keys(COLOR_MAP)) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ word: name, index: m.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

type ColorTarget = "wallpaper" | "bubble" | "text" | "accent";

const TARGET_PATTERNS: Array<{ target: ColorTarget; re: RegExp }> = [
  { target: "wallpaper", re: /\b(background|backdrop|wallpaper)\b/g },
  { target: "accent", re: /\baccent\b/g },
  { target: "text", re: /\b(text|letters|words|writing)\b/g },
  { target: "bubble", re: /\b(bubbles?|messages?)\b/g },
];

interface TargetHit {
  target: ColorTarget;
  index: number;
}

function findTargets(text: string): TargetHit[] {
  const hits: TargetHit[] = [];
  for (const { target, re } of TARGET_PATTERNS) {
    const rx = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      hits.push({ target, index: m.index });
    }
  }
  return hits;
}

export interface ColorBinding {
  target: ColorTarget;
  colorWord: string;
  incoming: boolean;
}

// Split on clause boundaries so each color is scored against the nouns in its own
// phrase first ("... white with blue bubbles" -> two independent clauses).
function splitClauses(text: string): string[] {
  return text
    .split(/,|;|\band\b|\bwith\b|\bbut\b|\./)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Bind every color mention to the target noun nearest to it. A color with no
// target noun anywhere in its clause falls back to bubbles, preserving the old
// behaviour for bare instructions like "make it green".
export function bindColors(instruction: string): ColorBinding[] {
  const bindings: ColorBinding[] = [];
  for (const clause of splitClauses(instruction)) {
    const colors = findColorWords(clause);
    if (colors.length === 0) continue;
    const targets = findTargets(clause);
    const incoming = hasIncomingWord(clause);
    for (const color of colors) {
      let target: ColorTarget = "bubble";
      if (targets.length > 0) {
        let best = targets[0];
        for (const t of targets) {
          if (Math.abs(t.index - color.index) < Math.abs(best.index - color.index)) best = t;
        }
        target = best.target;
      }
      bindings.push({ target, colorWord: color.word, incoming });
    }
  }
  return bindings;
}

function hexLuminance(hexColor: string): number {
  const clean = hexColor.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableTextColor(background: string): string {
  return hexLuminance(background) > 0.6 ? "#111111" : "#ffffff";
}

function shade(hexColor: string, factor: number): string {
  const clean = hexColor.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const channels = [0, 2, 4].map((i) => {
    const v = Math.round(parseInt(full.slice(i, i + 2), 16) * factor);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function mixHex(a: string, b: string): string {
  const parse = (h: string) => {
    const clean = h.replace("#", "");
    return clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  };
  const [fa, fb] = [parse(a), parse(b)];
  const channels = [0, 2, 4].map((i) => {
    const v = Math.round((parseInt(fa.slice(i, i + 2), 16) + parseInt(fb.slice(i, i + 2), 16)) / 2);
    return v.toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

// Illustrated scenes bundled in public/wallpapers. Ordered: earlier entries win,
// so "northern lights" resolves to aurora before the generic "lights" -> bokeh.
const SCENE_TRIGGERS: Array<{ scene: string; re: RegExp }> = [
  { scene: "aurora", re: /\b(aurora|northern lights)\b/ },
  { scene: "mountains", re: /\b(mountains?|alps|peaks?)\b/ },
  { scene: "city", re: /\b(city|skyline|urban|downtown)\b/ },
  { scene: "forest", re: /\b(forest|trees|woods|woodland)\b/ },
  { scene: "desert", re: /\b(desert|dunes|sahara)\b/ },
  { scene: "waves", re: /\bwaves\b/ },
  { scene: "confetti", re: /\b(confetti|party|celebration)\b/ },
  { scene: "bokeh", re: /\b(bokeh|blurry lights|fairy lights)\b/ },
];

const PATTERN_TRIGGERS: Array<{ pattern: string; re: RegExp }> = [
  { pattern: "stripes", re: /\b(stripes?|striped)\b/ },
  { pattern: "checks", re: /\b(checks?|checked|checkered|checkerboard)\b/ },
  { pattern: "crosshatch", re: /\b(crosshatch|hatched|hatching)\b/ },
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface ComponentTrigger {
  component: ComponentName;
  re: RegExp;
  computeOn?: (lower: string) => Action["on"];
}

const COMPONENT_TRIGGERS: ComponentTrigger[] = [
  {
    component: "TranslateButton",
    re: /\btranslate\b/,
    computeOn: (t) => (hasIncomingWord(t) ? "incoming" : "all"),
  },
  { component: "SummarizeButton", re: /\b(summarize|tl;?dr|recap)\b/ },
  { component: "CopyButton", re: /\bcopy\b/ },
  { component: "PinButton", re: /\bpin\b/ },
  { component: "ReactionBar", re: /\b(react|reaction|reactions|emoji|thumbs|heart)\b/ },
  { component: "ToneShifter", re: /\b(tone|rewrite|formal|casual)\b/ },
  { component: "SearchBox", re: /\b(search|find)\b/ },
  { component: "MuteToggle", re: /\b(mute|silence|do not disturb)\b/ },
  { component: "ReadReceipt", re: /\bread receipts?\b/, computeOn: () => "outgoing" },
  { component: "VoiceNote", re: /\bvoice (note|message|memo)\b|\bmic\b/ },
  { component: "GifPicker", re: /\bgifs?\b/ },
  { component: "Poll", re: /\bpolls?\b/ },
  { component: "ScheduledSend", re: /\bschedule[ds]?\b|\bscheduling\b|\bsend later\b/ },
  {
    component: "AIReplyDraft",
    re: /\bai reply\b|\bai draft\b|\bdraft a reply\b|\bsmart compose\b|\bwrite my reply\b/,
  },
  { component: "VideoCallButton", re: /\bvideo call\b|\bfacetime\b/ },
];

const REMOVAL_RE = /\b(remove|delete|get rid of|take away)\b/;

function applyComponents(spec: Spec, lower: string, changes: string[]): void {
  const removalIntent = REMOVAL_RE.test(lower);
  for (const trig of COMPONENT_TRIGGERS) {
    if (!trig.re.test(lower)) continue;
    const slot = COMPONENTS[trig.component].slot;
    const list = spec.slots[slot];
    const exists = list.some((a) => a.component === trig.component);
    if (removalIntent) {
      if (exists) {
        spec.slots[slot] = list.filter((a) => a.component !== trig.component);
        changes.push(`removed ${trig.component}`);
      }
      continue;
    }
    if (exists) continue;
    const props = propsSchemaFor(trig.component).parse({}) as Record<string, unknown>;
    const on = trig.computeOn ? trig.computeOn(lower) : "all";
    list.push({ component: trig.component, on, props });
    changes.push(`added ${trig.component}`);
  }
}

export interface DraftResult {
  spec: Spec;
  changes: string[];
  /** True when the stub matched keywords but could not confidently bind them
   *  (e.g. two different colors aimed at the same target). Blocks the free
   *  fast path so the instruction goes to the model instead of being guessed. */
  ambiguous: boolean;
}

export function draft(instructionRaw: string, current: Spec): DraftResult {
  const spec: Spec = structuredClone(current);
  const changes: string[] = [];

  if (/\b(reset|default|start over|revert|clear everything)\b/i.test(instructionRaw)) {
    changes.push("reset to default");
    return { spec: structuredClone(DEFAULT_SPEC), changes, ambiguous: false };
  }

  const lower = instructionRaw.toLowerCase();

  const titleMatch = instructionRaw.match(TITLE_RE);
  if (titleMatch && titleMatch[1].trim()) {
    spec.theme.chatTitle = titleMatch[1].trim().slice(0, 40);
    changes.push(`renamed chat to "${spec.theme.chatTitle}"`);
  }

  // --- colors, bound clause-by-clause to the thing they actually modify ---
  const bindings = bindColors(lower);
  const wantsGradient = /\bgradients?\b/.test(lower);
  let wallpaperClaimed = false;
  let ambiguous = false;

  if (wantsGradient) {
    const gradientColors = bindings
      .filter((b) => b.target === "wallpaper" || b.target === "bubble")
      .map((b) => COLOR_MAP[b.colorWord]);
    if (gradientColors.length >= 2) {
      spec.theme.gradientFrom = gradientColors[0];
      spec.theme.gradientTo = gradientColors[gradientColors.length - 1];
      spec.theme.gradientVia =
        gradientColors.length >= 3
          ? gradientColors[1]
          : mixHex(gradientColors[0], gradientColors[1]);
      spec.theme.wallpaper = "gradient";
      wallpaperClaimed = true;
      changes.push("wallpaper -> gradient");
    } else if (gradientColors.length === 1) {
      // One color still makes a gradient: fade it into a deeper shade of itself.
      spec.theme.gradientFrom = gradientColors[0];
      spec.theme.gradientVia = shade(gradientColors[0], 0.75);
      spec.theme.gradientTo = shade(gradientColors[0], 0.45);
      spec.theme.wallpaper = "gradient";
      wallpaperClaimed = true;
      changes.push("wallpaper -> gradient");
    }
  } else {
    const seen = new Map<string, string>();
    for (const b of bindings) {
      const hexVal = COLOR_MAP[b.colorWord];
      const key = `${b.target}:${b.incoming}`;
      // Two different colors aimed at the same thing means we misread the
      // sentence. Don't guess — the fast-path gate hands it to the model.
      if (seen.has(key) && seen.get(key) !== hexVal) ambiguous = true;
      seen.set(key, hexVal);

      switch (b.target) {
        case "wallpaper":
          spec.theme.wallpaper = "custom";
          spec.theme.wallpaperColor = hexVal;
          wallpaperClaimed = true;
          changes.push(`background -> ${b.colorWord}`);
          break;
        case "accent":
          spec.theme.accentColor = hexVal;
          changes.push(`accent -> ${b.colorWord}`);
          break;
        case "text":
          if (b.incoming) {
            spec.theme.textColorIncoming = hexVal;
            changes.push(`incoming text -> ${b.colorWord}`);
          } else {
            spec.theme.textColorOutgoing = hexVal;
            changes.push(`outgoing text -> ${b.colorWord}`);
          }
          break;
        case "bubble":
          if (b.incoming) {
            spec.theme.bubbleColorIncoming = hexVal;
            spec.theme.textColorIncoming = readableTextColor(hexVal);
            changes.push(`incoming bubbles -> ${b.colorWord}`);
          } else {
            spec.theme.bubbleColorOutgoing = hexVal;
            spec.theme.textColorOutgoing = readableTextColor(hexVal);
            changes.push(`outgoing bubbles -> ${b.colorWord}`);
          }
          break;
      }
    }
    // An explicit text color must win over the auto-contrast a bubble color picks.
    for (const b of bindings.filter((x) => x.target === "text")) {
      if (b.incoming) spec.theme.textColorIncoming = COLOR_MAP[b.colorWord];
      else spec.theme.textColorOutgoing = COLOR_MAP[b.colorWord];
    }
  }

  // --- illustrated scenes ---
  for (const { scene, re } of SCENE_TRIGGERS) {
    if (re.test(lower)) {
      spec.theme.wallpaper = "image";
      spec.theme.wallpaperImage = scene as typeof spec.theme.wallpaperImage;
      wallpaperClaimed = true;
      changes.push(`wallpaper -> ${scene}`);
      break;
    }
  }

  // --- pattern overlays ---
  for (const { pattern, re } of PATTERN_TRIGGERS) {
    if (re.test(lower)) {
      spec.theme.wallpaperPattern = pattern as typeof spec.theme.wallpaperPattern;
      changes.push(`pattern -> ${pattern}`);
      break;
    }
  }
  // "blue background with dots" layers dots ON the blue, rather than the old
  // fixed grey-on-white dots preset replacing the color outright.
  if (wallpaperClaimed && /\b(dots|polka)\b/.test(lower)) {
    spec.theme.wallpaperPattern = "dots";
    changes.push("pattern -> dots");
  } else if (wallpaperClaimed && /\bgrid\b|\bgraph paper\b/.test(lower)) {
    spec.theme.wallpaperPattern = "grid";
    changes.push("pattern -> grid");
  }

  if (/\b(bigger|larger|huge)\b/.test(lower)) {
    const next = Math.min(1.6, round1(spec.theme.bubbleScale + 0.2));
    if (next !== spec.theme.bubbleScale) {
      spec.theme.bubbleScale = next;
      changes.push("bigger bubbles");
    }
  } else if (/\b(smaller|tiny|shrink)\b/.test(lower)) {
    const next = Math.max(0.8, round1(spec.theme.bubbleScale - 0.2));
    if (next !== spec.theme.bubbleScale) {
      spec.theme.bubbleScale = next;
      changes.push("smaller bubbles");
    }
  }

  const roundedFont = /\bfont\b/.test(lower) && /\b(rounded|bubbly|friendly)\b/.test(lower);
  if (/\bpill\b|\bcapsule\b/.test(lower)) {
    spec.theme.cornerStyle = "pill";
    changes.push("corners -> pill");
  } else if (/\b(square|sharp|boxy)\b/.test(lower)) {
    spec.theme.cornerStyle = "tight";
    changes.push("corners -> tight");
  } else if (!roundedFont && /\b(round|rounded)\b/.test(lower)) {
    spec.theme.cornerStyle = "round";
    changes.push("corners -> round");
  }

  // Legacy named presets only apply if nothing more specific already claimed the
  // background — otherwise "white background with dark bubbles" would have the
  // charcoal preset stomp the explicit white.
  if (wallpaperClaimed) {
    // background already decided above
  } else if (/\bsunset\b/.test(lower)) {
    spec.theme.wallpaper = "sunset";
    changes.push("wallpaper -> sunset");
  } else if (/\b(ocean|sea|beach)\b/.test(lower)) {
    spec.theme.wallpaper = "ocean";
    changes.push("wallpaper -> ocean");
  } else if (/\b(dark|charcoal|night)\b/.test(lower)) {
    spec.theme.wallpaper = "charcoal";
    spec.theme.bubbleColorIncoming = "#2c2c2e";
    spec.theme.textColorIncoming = "#f2f2f7";
    changes.push("dark mode");
  } else if (/\b(dots|polka)\b/.test(lower)) {
    spec.theme.wallpaper = "dots";
    changes.push("wallpaper -> dots");
  } else if (/\bgrid\b|\bgraph paper\b/.test(lower)) {
    spec.theme.wallpaper = "grid";
    changes.push("wallpaper -> grid");
  } else if (/\bno background\b|\bplain background\b/.test(lower)) {
    spec.theme.wallpaper = "none";
    changes.push("wallpaper -> none");
  }

  if (roundedFont) {
    spec.theme.fontFamily = "rounded";
    changes.push("font -> rounded");
  } else if (/\b(monospace|mono|code font|typewriter)\b/.test(lower)) {
    spec.theme.fontFamily = "mono";
    changes.push("font -> mono");
  } else if (/\b(serif|classic|book)\b/.test(lower) && /\bfont\b/.test(lower)) {
    spec.theme.fontFamily = "serif";
    changes.push("font -> serif");
  }

  if (/\b(tighter|denser|compact)\b/.test(lower)) {
    spec.theme.density = "compact";
    changes.push("density -> compact");
  } else if (/\b(roomier|spacious|airy|spread out)\b/.test(lower)) {
    spec.theme.density = "spacious";
    changes.push("density -> spacious");
  }

  if (/\bavatars?\b/.test(lower)) {
    if (/\b(hide|remove|no)\b\s*(\w+\s+){0,3}avatars?\b/.test(lower)) {
      spec.theme.showAvatars = false;
      changes.push("avatars off");
    } else if (/\b(show|add)\b\s*(\w+\s+){0,3}avatars?\b/.test(lower)) {
      spec.theme.showAvatars = true;
      changes.push("avatars on");
    }
  }

  if (/\btimestamps?\b|\btime\b/.test(lower)) {
    if (/\b(hide|remove|no)\b\s*(\w+\s+){0,3}(timestamps?|time)\b/.test(lower)) {
      spec.theme.showTimestamps = false;
      changes.push("timestamps off");
    } else if (/\b(show|add)\b\s*(\w+\s+){0,3}(timestamps?|time)\b/.test(lower)) {
      spec.theme.showTimestamps = true;
      changes.push("timestamps on");
    }
  }

  if (/\bsend\s+(button|icon)\b/.test(lower)) {
    if (/\bplane\b/.test(lower)) {
      spec.theme.sendButtonStyle = "plane";
      changes.push("send button -> plane");
    } else if (/\bheart\b/.test(lower)) {
      spec.theme.sendButtonStyle = "heart";
      changes.push("send button -> heart");
    } else if (/\b(dot|circle)\b/.test(lower)) {
      spec.theme.sendButtonStyle = "dot";
      changes.push("send button -> dot");
    } else if (/\barrow\b/.test(lower)) {
      spec.theme.sendButtonStyle = "arrow";
      changes.push("send button -> arrow");
    }
  }

  if (/\btails?\b/.test(lower)) {
    const off = /\b(no|remove|without|hide)\b\s*(\w+\s+){0,3}tails?\b/.test(lower);
    spec.theme.bubbleTail = !off;
    changes.push(off ? "tails off" : "tails on");
  }

  if (/\b(sentiment|mood)\b/.test(lower)) {
    const off = /\b(no|remove|off|stop)\b\s*(\w+\s+){0,3}(sentiment|mood)\b/.test(lower);
    spec.theme.sentimentTint = !off;
    changes.push(off ? "sentiment tint off" : "sentiment tint on");
  }

  applyComponents(spec, lower, changes);

  return { spec, changes, ambiguous };
}

// ---------------------------------------------------------------------------
// The fast-path gate: the stub result is used directly only when it validates,
// made a change, AND the instruction has no leftover content the stub didn't
// understand. Otherwise a compound instruction like "green bubbles and
// confetti when I send" would silently apply only the recognized half.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "please", "can", "you", "your", "make", "set", "turn", "change", "want",
  "just", "really", "to", "of", "for", "and", "or", "my", "our", "their", "it", "its", "is",
  "are", "be", "with", "in", "on", "at", "this", "that", "some", "all", "more", "less", "like",
  "as", "so", "get", "got", "let", "lets", "i", "we", "they", "them", "he", "she", "him", "her",
  "his", "up", "down", "out", "into", "over", "from", "than", "then", "now", "could", "would",
  "should", "will", "gonna", "also", "too", "very", "bit", "little", "pls", "hey", "ok", "okay",
  "yeah", "yep", "sure", "thanks", "thank", "need", "needs", "have", "has", "had", "do", "does",
]);

const VOCAB = new Set([
  ...Object.keys(COLOR_MAP),
  "bubble", "bubbles",
  "bigger", "larger", "huge", "smaller", "tiny", "shrink",
  "square", "sharp", "boxy", "round", "rounded", "pill", "capsule", "tight", "soft",
  "sunset", "ocean", "sea", "beach", "dark", "mode", "charcoal", "night", "dots", "polka", "grid",
  "graph", "paper", "background", "backdrop", "wallpaper", "plain", "none",
  "gradient", "gradients", "fade", "stripes", "striped", "checks", "checked", "checkered",
  "checkerboard", "crosshatch", "hatched", "hatching", "pattern",
  "mountains", "mountain", "alps", "peaks", "city", "skyline", "urban", "downtown", "forest",
  "trees", "woods", "woodland", "desert", "dunes", "sahara", "waves", "aurora", "northern",
  "lights", "confetti", "party", "celebration", "bokeh", "blurry", "fairy", "scene", "photo",
  "picture", "image", "text", "letters", "words", "writing",
  "font", "bubbly", "friendly", "mono", "monospace", "code", "typewriter", "serif", "classic",
  "book",
  "tighter", "denser", "compact", "roomier", "spacious", "airy", "spread",
  "avatar", "avatars", "hide", "remove", "show", "add", "no", "time", "timestamp", "timestamps",
  "translate", "summarize", "tldr", "recap", "copy", "pin", "react", "reaction", "reactions",
  "emoji", "thumbs", "heart", "suggest", "suggestions", "autocomplete", "tone", "rewrite",
  "formal", "casual", "search", "find", "mute", "silence", "disturb", "read", "receipt",
  "receipts", "voice", "note", "message", "messages", "memo", "mic", "gif", "gifs", "picker",
  "poll", "polls",
  "schedule", "scheduled", "scheduling", "later", "ai", "reply", "drafter", "draft", "smart",
  "compose", "write", "video", "call", "facetime",
  "accent", "color", "tail", "tails", "tint", "mood", "sentiment", "title", "rename", "reset",
  "default", "revert", "call", "name", "chat",
  "start", "over", "clear", "everything",
  "send", "button", "icon", "arrow", "plane", "dot", "circle",
  "delete", "rid", "away", "their", "incoming", "other", "friends", "friend", "received",
]);

export function residualContentWords(instruction: string): string[] {
  const stripped = instruction.replace(TITLE_RE, " ");
  const cleaned = stripped.toLowerCase().replace(/[^a-z\s]/g, " ");
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !VOCAB.has(w));
}

// ---------------------------------------------------------------------------
// Rungs 2 & 3: the model, and one escalation retry on an invalid response.
// ---------------------------------------------------------------------------

type ModelResult =
  | { status: "ok"; spec: Spec; summary: string | null; limitation: string | null; backgroundImagePrompt: string | null }
  | { status: "invalid"; error: string }
  | { status: "unavailable" };

export function buildSystemPrompt(): string {
  const tokenLines = Object.entries(THEME_TOKENS).map(([name, desc]) => {
    let constraint: string;
    switch (desc.kind) {
      case "text":
        constraint = `text, max ${desc.maxLength} chars`;
        break;
      case "color":
        constraint = "a hex color like #34c759";
        break;
      case "number":
        constraint = `number between ${desc.min} and ${desc.max}`;
        break;
      case "enum":
        constraint = `one of: ${desc.values.join(", ")}`;
        break;
      case "boolean":
        constraint = "true or false";
        break;
    }
    return `- ${name} (${desc.kind}): ${desc.label}. ${constraint}`;
  });

  const slotLines = SLOT_NAMES.map(
    (slot) => `- ${slot} — ${SLOTS[slot].label}. Allowed components: ${SLOTS[slot].allow.join(", ")}.`,
  );

  return [
    "You are the theming engine for Piper, an iMessage-style chat app that users reshape by typing instructions.",
    "You may ONLY select values from the registry below. Anything outside this surface (unknown component, out-of-range value, component in the wrong slot) is rejected by a validator, so do not invent theme tokens, components, or props.",
    "",
    "Theme tokens:",
    ...tokenLines,
    "",
    "How the background works — `wallpaper` picks the BASE layer, and the other tokens only apply to the base they belong to:",
    '- wallpaper "custom" -> paints the solid color in wallpaperColor. Use this for "make the background yellow".',
    '- wallpaper "gradient" -> paints a 3-stop gradient from gradientFrom via gradientVia to gradientTo, at gradientAngle degrees. Use this for "sunset fade", "blue to purple", any multi-color background. Pick genuinely pleasing stops.',
    '- wallpaper "image" -> paints the illustrated scene named in wallpaperImage. ONLY these 8 fixed scenes exist as pre-drawn art.',
    '- wallpaper "none"/"dots"/"grid"/"sunset"/"ocean"/"charcoal" -> legacy fixed presets.',
    '- NOTE: "generated" is NOT a value you can set for `wallpaper` — it is reserved for the system to set automatically after a real image is generated (see IMAGE GENERATION below). Always pick one of the values above instead.',
    "- wallpaperPattern is a SEPARATE overlay drawn on top of whichever base is chosen, at patternOpacity strength. So \"blue background with stripes\" = wallpaper custom + wallpaperColor blue + wallpaperPattern stripes.",
    "",
    "Bind each part of the instruction to the thing it actually describes: in \"white background with blue bubbles\", white is the background and blue is bubbleColorOutgoing — do not collapse them into one change. Keep text readable against whatever bubble and background colors you choose.",
    "",
    'Slots (each action has the shape {"component": name, "on": "incoming"|"outgoing"|"all", "props": {...optional}}):',
    ...slotLines,
    "",
    "Some components take props — set these when the instruction specifies them, otherwise omit props and the defaults apply:",
    '- TranslateButton: {"target": <language name, e.g. "Chinese", "Japanese", "French"> } — free text, any language. If the instruction names a language ("add a translate button for Chinese"), you MUST set target to that language, not leave it defaulted.',
    '- ReactionBar: {"emojis": [array of up to 6 emoji]}',
    '- Poll: {"question": string, "options": [array of up to 4 strings]}',
    '- ToneShifter: {"tones": [array from "formal","casual","warm","concise"]}',
    '- ThemeBadge: {"text": string, max 24 chars}',
    "",
    "",
    "ESCAPE HATCHES — for anything the token list above can't express (unusual shapes, glows, custom animations, effects on events, or a whole new interactive widget). Use these INSTEAD of forcing a request into a token that doesn't really fit.",
    "",
    '1. `customCSS` — an object keyed by zone: "bubbleOutgoing", "bubbleIncoming", "background", "header". Each zone\'s value is an object of real CSS properties in camelCase (React inline-style syntax, e.g. "backgroundColor", "clipPath", "boxShadow", "border", "filter", "animation"), with plain string values. This is how you do things tokens can\'t: glows, custom borders beyond the border tokens, textured backgrounds, unusual shapes, etc. These merge on TOP of the theme tokens — you don\'t need to also set the token version of something you\'re overriding here.',
    '2. `customCSSText` — a string of raw CSS, injected verbatim in a <style> tag. This is the ONLY place `@keyframes` can be defined. If you want an animated bubble (pulse, wobble, wiggle), define the `@keyframes` here and reference the animation by name in customCSS\'s `animation` property for the relevant zone.',
    '3. `customEffects` — an object with optional keys "onLoad", "onMessageReceived", "onMessageSent", "onReaction", each a STRING of plain JavaScript (a function body, not a full function), with one variable available: `container`, a real DOM element positioned over the whole chat. ALWAYS use `container.appendChild(...)` — never `document.body.appendChild(...)`, which escapes the chat entirely and can render outside the visible chat panel where it\'s easy to miss or looks broken.',
    "   - `onMessageReceived`/`onMessageSent`/`onReaction` are ONE-SHOT: the code runs once when that specific event happens, then should clean up after itself (setTimeout to remove what it created). Use these for something tied to an event — confetti on receive, a flash on reaction. These do NOT run continuously and do NOT run immediately when applied — only the next time that event actually occurs.",
    '   - `onLoad` is DIFFERENT: it runs ONCE, immediately, when the change is applied (not tied to any message/reaction event) — use this for anything AMBIENT, CONTINUOUS, or PERSISTENT ("slithers around the screen", "floats around continuously", "always drifting", anything with no natural end). The code should create its element(s) once and set up an INFINITE CSS animation (`animation-iteration-count: infinite`, or omit the count in a shorthand that already implies it, e.g. reference an `@keyframes` in `customCSSText` with `animation: name 8s linear infinite`) so it keeps running on its own — do NOT setTimeout-remove it, and do NOT try to make an infinite effect out of onMessageReceived/onMessageSent/onReaction, since those only fire when that specific event happens, not continuously.',
    "   - Getting this distinction right matters: a request for continuous/ambient motion mapped onto a message-triggered event will falsely report success while only ever appearing right after that event fires, which reads as \"nothing happened\" the rest of the time — always prefer onLoad for anything described as ongoing, moving on its own, or without a clear one-time trigger.",
    '   - Example onLoad value for "a small snake that continuously slithers across the screen" (paired with `customCSSText` defining `@keyframes slither {...}`): "const snake = document.createElement(\'div\'); snake.textContent = \'🐍\'; snake.style.position = \'absolute\'; snake.style.fontSize = \'24px\'; snake.style.animation = \'slither 8s linear infinite\'; container.appendChild(snake);"',
    '   - Example onMessageReceived value (one-shot, event-triggered): "for (let i = 0; i < 20; i++) { const p = document.createElement(\'div\'); p.textContent = \'🎉\'; p.style.position = \'absolute\'; p.style.left = Math.random()*100 + \'%\'; p.style.top = \'-20px\'; p.style.fontSize = \'20px\'; p.style.transition = \'transform 1.2s ease-in, opacity 1.2s\'; container.appendChild(p); requestAnimationFrame(() => { p.style.transform = \'translateY(300px)\'; p.style.opacity = \'0\'; }); setTimeout(() => p.remove(), 1300); }"',
    '4. `customComponents` — a whole new INTERACTIVE widget, for requests the other hatches can\'t reach because they need real state/behavior, not just style or a one-shot effect: a countdown timer, a small calculator, a mini game, anything with its own ongoing UI. An array of up to 5 objects: {"id": <short stable slug, e.g. "countdown-timer">, "label": <short human name shown if it errors, e.g. "Countdown Timer">, "slot": "composerActions"|"headerActions"|"standalone", "code": <string, see contract below>}.',
    "   - CODE CONTRACT (strict — anything else fails to compile): the string must define EXACTLY one top-level `function Component(props) { ... }` using JSX to return its UI, and nothing else — no import/export statements, no code outside that one function. React and the hooks useState/useEffect/useRef are already in scope — call them directly (`useState(0)`, not `React.useState(0)`).",
    '   - `props` gives you: `messages` (the current message list, read-only), `viewerId` (string), `sendMessage(text)` (a function — call it to send a real message into the chat, e.g. for a timer that announces when it hits zero).',
    '   - Pick `slot` by size: "composerActions" or "headerActions" for something small and pill-shaped (a button, a live number); "standalone" for something that needs more room (a small canvas, a multi-button calculator) — it gets its own full-width strip.',
    "   - Keep it robust: clean up every `setInterval`/`setTimeout` in a `useEffect` cleanup function so it doesn't run forever after the user moves on; avoid unbounded loops.",
    "   - SIZE IS ENFORCED, not just a suggestion: \"standalone\" renders in a strip capped at 240px tall (scrolls internally past that) — never use `position: fixed` or a large explicit width/height inside your JSX, since that can visually cover the chat instead of sitting inside your allotted space. For a grid-based widget (tic-tac-toe, a small game board), keep each cell small (e.g. 32-40px) so the whole board comfortably fits well under the height cap — do not assume you have the whole screen.",
    '   - To ADD one: include it in `customComponents` alongside any existing ones that should stay (you are given the current spec, including any that already exist — echo them back unchanged unless the instruction is about them specifically). To MODIFY one: keep its `id`, change what needs to change. To REMOVE one: simply leave it out of the array — but note the user ALSO has a direct "✕" button on every component that removes it instantly without needing you, so don\'t worry about being asked to remove something that may already be gone.',
    '   - Example minimal `code` value for "add a 60 second countdown timer": "function Component({ sendMessage }) {\\n  const [seconds, setSeconds] = useState(60);\\n  useEffect(() => {\\n    if (seconds <= 0) { sendMessage(\'Time\\\'s up!\'); return; }\\n    const id = setTimeout(() => setSeconds(s => s - 1), 1000);\\n    return () => clearTimeout(id);\\n  }, [seconds]);\\n  return <span>⏱ {seconds}s</span>;\\n}"',
    "",
    "LEGIBILITY IS NON-NEGOTIABLE. Every message must stay fully readable after your change — never let a shape, clip, mask, texture, or color combination cover, crop, or wash out the text. Concretely:",
    '- If you touch `color` or the bubble\'s background anywhere (token or customCSS), keep them at strong contrast (dark text on light backgrounds, light text on dark ones).',
    '- For unusual bubble SHAPES (e.g. "cloud-shaped", "blob-shaped"), prefer an irregular `borderRadius` (e.g. "255px 15px 225px 15px / 15px 225px 15px 255px") or layered `boxShadow` "puffs" around the edge — these read as soft/rounded/cloud-like without ever touching the interior where the text sits. AVOID `clipPath` for bubble shapes: a clip-path crops the box itself, and an imprecise polygon (the usual failure mode) slices straight through letters. If you do use `clipPath`, keep it in the outer ~15% margin of the box and set generous padding (at least "0.85rem 1.2rem") so the entire text area sits inside the untouched center.',
    "- Never set an animation that moves, rotates, or fades the text itself to the point of unreadability — animate a border, glow, or background instead of the bubble's content box when in doubt.",
    "",
    "Use the token list for anything it already covers (colors, fonts, corner style, tail, borders, backgrounds) — it's simpler and cheaper. Reach for the escape hatches only when the request genuinely needs a shape, glow, animation, one-shot effect, or real interactive widget the tokens don't have a slot for — and prefer the SIMPLEST hatch that satisfies the request (customCSS over customEffects over customComponents). Leave customCSS zones/customCSSText/customEffects keys/customComponents you're not touching as empty/null/unchanged rather than guessing values for them.",
    "",
    "The full spec shape is:",
    '{"version":1,"theme":{...all 20 tokens...},"slots":{"messageActions":[],"composerActions":[],"headerActions":[]},"customCSSText":"","customCSS":{"bubbleOutgoing":{},"bubbleIncoming":{},"background":{},"header":{}},"customEffects":{"onLoad":null,"onMessageReceived":null,"onMessageSent":null,"onReaction":null},"customComponents":[]}',
    "",
    "Start from the current spec the user provides, apply the instruction, and keep everything else unchanged.",
    "",
    "IMAGE GENERATION: if the request describes visual content that needs real generated artwork — an animal, a character, a specific object or place, a style (\"cartoon\", \"watercolor\", \"pixel art\"), anything the 8 fixed scenes don't cover — set `backgroundImagePrompt` to a good, specific, safe image-generation prompt (style + subject, e.g. \"a cute cartoon dog, flat illustration style, colorful, simple background, no text\"). A few seconds after your response, the system will actually generate that image and switch the background to it on its own — you never set `wallpaper` to \"generated\" or touch `wallpaperUrl` yourself, ever (see the NOTE above). Instead, set `theme.wallpaper` to a normal value (the closest of the 8 fixed scenes, or a gradient) exactly as you would for any other request — that's what's shown while generating, and what stays shown if generation fails, so make it a genuine best-effort, not a placeholder. When backgroundImagePrompt is set, leave `limitation` null — the system handles explaining a generation failure itself if one occurs. When the request has NO image-generation need, leave `backgroundImagePrompt` null.",
    "",
    "For every OTHER kind of request the token list + escape hatches above still can't fully satisfy (not image-related), pick the best available approximation and explain honestly in `limitation` rather than silently substituting — e.g. an out-of-scope request for real audio, a data type nothing here can represent, etc.",
    "",
    "Output a JSON OBJECT with exactly these keys — not the bare spec:",
    '{"spec": {...the full spec, shape above...}, "summary": <short phrase describing what you actually changed, e.g. "set background to a green forest scene">, "limitation": <string|null — null if you fully did what was literally asked (including when backgroundImagePrompt is set — that counts as fully honoring it); otherwise ONE sentence explaining what you couldn\'t do and what you did instead>, "backgroundImagePrompt": <string|null — a generation prompt as described above, or null>}',
    "",
    "Return ONLY that JSON object. No markdown, no commentary outside the object.",
  ].join("\n");
}

export function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function callModel(instruction: string, current: Spec, model?: string): Promise<ModelResult> {
  let res: Response;
  try {
    res = await apiPost("/api/generate", {
      system: buildSystemPrompt(),
      instruction,
      spec: current,
      model,
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!res.ok) {
    return { status: "unavailable" };
  }
  const data = (await res.json()) as { raw: string };
  let envelope: unknown;
  try {
    envelope = extractJson(data.raw);
  } catch {
    return { status: "invalid", error: "model response was not valid JSON" };
  }
  // Accept either the new {spec, summary, limitation} envelope or a bare
  // spec object, so an older/escalation-model response that ignores the
  // envelope instruction still works rather than hard-failing.
  const candidateSpec =
    envelope && typeof envelope === "object" && "spec" in envelope
      ? (envelope as { spec: unknown }).spec
      : envelope;
  const validated = validateSpec(candidateSpec);
  if (!validated.ok) {
    return { status: "invalid", error: validated.error };
  }
  const summary =
    envelope && typeof envelope === "object" && typeof (envelope as { summary?: unknown }).summary === "string"
      ? (envelope as { summary: string }).summary
      : null;
  const limitation =
    envelope && typeof envelope === "object" && typeof (envelope as { limitation?: unknown }).limitation === "string"
      ? (envelope as { limitation: string }).limitation
      : null;
  const backgroundImagePrompt =
    envelope &&
    typeof envelope === "object" &&
    typeof (envelope as { backgroundImagePrompt?: unknown }).backgroundImagePrompt === "string"
      ? (envelope as { backgroundImagePrompt: string }).backgroundImagePrompt
      : null;
  return { status: "ok", spec: enforceLegibility(validated.spec), summary, limitation, backgroundImagePrompt };
}

export interface GenerateResult {
  spec: Spec;
  summary: string;
  matched: boolean;
  // Set when the model couldn't literally honor the request and had to
  // approximate/substitute — e.g. "cartoon dog background" when Piper has no
  // image generation, only 8 fixed scenes. Surfaced distinctly so a
  // substitution is never silent.
  limitation?: string;
}

// When the model set backgroundImagePrompt, actually generate the image and
// swap it into the spec. On failure, keep the model's own fallback wallpaper
// (it was told to always provide one) and explain the failure instead of the
// model's null limitation — the model can't know in advance whether
// generation will succeed, so this is the one limitation the CLIENT writes
// rather than the model.
async function resolveBackgroundImage(result: GenerateResult & { backgroundImagePrompt: string | null }): Promise<GenerateResult> {
  const { backgroundImagePrompt, ...rest } = result;
  if (!backgroundImagePrompt) return rest;
  const image = await generateBackgroundImage(backgroundImagePrompt);
  if (image.ok) {
    return {
      ...rest,
      spec: { ...rest.spec, theme: { ...rest.spec.theme, wallpaper: "generated", wallpaperUrl: image.url } },
      summary: rest.summary === "updated (via Claude)" || !rest.summary ? "generated a custom background image" : rest.summary,
    };
  }
  // Defense in depth: the model is instructed to never set wallpaper to
  // "generated" itself (that's reserved for a successful result, right
  // above), but if it disobeys anyway, leaving it as "generated" with no URL
  // renders as blank white and — worse — gets persisted, making every future
  // request look like a no-op change against that broken saved state. Fall
  // back to the spec's own gradient tokens (always present, always valid)
  // rather than trust the model's wallpaper value in the failure path.
  const spec =
    rest.spec.theme.wallpaper === "generated"
      ? { ...rest.spec, theme: { ...rest.spec.theme, wallpaper: "gradient" as const } }
      : rest.spec;
  return {
    ...rest,
    spec,
    limitation: `Couldn't generate a custom image (${image.error}) — used a built-in option instead.`,
  };
}

// Compiling customComponents is deferred to render time in Chat.tsx (that's
// what keeps Babel out of the base bundle for anyone who never uses this).
// But that means the orchestrator would otherwise report "success" the
// instant it gets a valid, DIFFERENT spec back — with no idea whether the
// component's code will actually compile AND render. Runs the exact same
// compiler here, before claiming success, so a broken component shows up as
// a limitation (amber notice) instead of a false green checkmark. Only loads
// Babel/react-dom-server when there's actually a component to check.
//
// Compiling alone isn't enough — it only proves the code is syntactically
// valid, not that it runs. (Concretely: this is how a Babel-version JSX
// runtime mismatch slipped through once already — the transform succeeded,
// the function reference was constructed fine, and it only threw when
// actually invoked during render.) renderToStaticMarkup smoke-tests an
// actual invocation without mounting it into the live UI or running
// useEffect (which only fires post-mount in real DOM rendering, so this
// can't trigger side effects like starting a timer or sending a message).
async function validateCustomComponents(result: GenerateResult): Promise<GenerateResult> {
  if (result.spec.customComponents.length === 0) return result;
  const [{ compileCustomComponent }, babel, React, ReactDOMServer] = await Promise.all([
    import("../components/customComponentRuntime"),
    import("@babel/standalone"),
    import("react"),
    import("react-dom/server"),
  ]);
  const failures: string[] = [];
  for (const c of result.spec.customComponents) {
    try {
      const Comp = compileCustomComponent(babel, c.code);
      ReactDOMServer.renderToStaticMarkup(
        React.createElement(Comp, { messages: [], viewerId: "", sendMessage: () => {} }),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`"${c.label}" couldn't be built (${reason}) — use its ✕ to remove it.`);
    }
  }
  if (failures.length === 0) return result;
  return { ...result, limitation: [result.limitation, ...failures].filter(Boolean).join(" ") };
}

// Syntax-only check (not a smoke test — customEffects are plain event
// handlers, not something safely callable without a real container/DOM
// side effects) before claiming success, same principle as
// validateCustomComponents: a broken effect should show up as a limitation,
// not a silent console.warn the first time it actually runs.
function validateCustomEffectsSyntax(result: GenerateResult): GenerateResult {
  const failures: string[] = [];
  for (const [event, code] of Object.entries(result.spec.customEffects)) {
    if (!code) continue;
    try {
      // eslint-disable-next-line no-new-func
      new Function("container", code);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`the "${event}" effect has a syntax error (${reason}) and won't run.`);
    }
  }
  if (failures.length === 0) return result;
  return { ...result, limitation: [result.limitation, ...failures].filter(Boolean).join(" ") };
}

// The free, instant fast path in isolation: returns a spec only when the keyword
// stub fully and unambiguously understood the instruction. The orchestrator uses
// this to short-circuit common theme edits before ever calling the router, so a
// plain "green bubbles" costs nothing. null means "not confidently keyword-only —
// hand it to the model/router".
export function keywordOnly(instruction: string, current: Spec): { spec: Spec; summary: string } | null {
  const trimmed = instruction.trim();
  if (!trimmed) return null;
  const stubResult = draft(trimmed, current);
  const stubValidation = validateSpec(stubResult.spec);
  const residual = residualContentWords(trimmed);
  const ok =
    stubValidation.ok &&
    stubResult.changes.length > 0 &&
    residual.length === 0 &&
    !stubResult.ambiguous;
  if (!ok || !stubValidation.ok) return null;
  return { spec: stubValidation.spec, summary: stubResult.changes.join(", ") };
}

export async function generateSpec(
  instruction: string,
  current: Spec,
  model?: string,
): Promise<GenerateResult> {
  const trimmed = instruction.trim();
  if (!trimmed) {
    return { spec: current, summary: "type an instruction first", matched: false };
  }

  const stubResult = draft(trimmed, current);
  const stubValidation = validateSpec(stubResult.spec);
  const residual = residualContentWords(trimmed);
  const canFastPath =
    stubValidation.ok &&
    stubResult.changes.length > 0 &&
    residual.length === 0 &&
    !stubResult.ambiguous;

  if (canFastPath && stubValidation.ok) {
    return { spec: stubValidation.spec, summary: stubResult.changes.join(", "), matched: true };
  }

  const modelResult = await callModel(trimmed, current, model);

  // A validated spec that's byte-identical to the input means the model tried
  // and failed to find a representable change — that's functionally the same
  // failure as an invalid response, so both retry with the escalation model
  // and, if that also comes back empty, tell the user plainly rather than
  // reporting a false "updated" when nothing visibly changed.
  if (modelResult.status === "ok" && !specsEqual(modelResult.spec, current)) {
    return validateCustomEffectsSyntax(
      await validateCustomComponents(
        await resolveBackgroundImage({
          spec: modelResult.spec,
          summary: modelResult.summary ?? "updated (via Claude)",
          matched: true,
          limitation: modelResult.limitation ?? undefined,
          backgroundImagePrompt: modelResult.backgroundImagePrompt,
        }),
      ),
    );
  }

  if (modelResult.status === "ok" || modelResult.status === "invalid") {
    const escalated = await callModel(trimmed, current, ESCALATION_MODEL);
    if (escalated.status === "ok" && !specsEqual(escalated.spec, current)) {
      return validateCustomEffectsSyntax(
        await validateCustomComponents(
          await resolveBackgroundImage({
            spec: escalated.spec,
            summary: escalated.summary ?? "updated (via Claude, escalated)",
            matched: true,
            limitation: escalated.limitation ?? undefined,
            backgroundImagePrompt: escalated.backgroundImagePrompt,
          }),
        ),
      );
    }
    const errorText =
      escalated.status === "invalid"
        ? escalated.error
        : escalated.status === "ok"
          ? "no representable change found"
          : "model unavailable";
    return {
      spec: current,
      summary: `the model couldn't produce a valid change (${errorText})`,
      matched: false,
    };
  }

  // status === "unavailable": proxy offline or no key. Fall back to the stub.
  if (stubValidation.ok && stubResult.changes.length > 0) {
    return {
      spec: stubValidation.spec,
      summary: `${stubResult.changes.join(", ")} (keyword-only — connect the API for free-form requests)`,
      matched: true,
    };
  }
  return {
    spec: current,
    summary: 'try "make my bubbles green", "dark mode", "add a poll", or "reset"',
    matched: false,
  };
}
