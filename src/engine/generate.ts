import {
  COMPONENTS,
  SLOT_NAMES,
  SLOTS,
  THEME_TOKENS,
  propsSchemaFor,
  type ComponentName,
} from "./registry";
import { DEFAULT_SPEC, specsEqual, validateSpec, type Action, type Spec } from "./spec";
import { apiPost } from "../lib/api";

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
  { component: "SendSuggestions", re: /\b(suggest|smart reply|autocomplete)\b/ },
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
  | { status: "ok"; spec: Spec }
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
    '- wallpaper "image" -> paints the illustrated scene named in wallpaperImage. ONLY the listed scenes exist; there is no way to fetch or generate any other picture, so if the user asks for a photo you cannot provide, pick the closest listed scene or use a gradient instead.',
    '- wallpaper "none"/"dots"/"grid"/"sunset"/"ocean"/"charcoal" -> legacy fixed presets.',
    "- wallpaperPattern is a SEPARATE overlay drawn on top of whichever base is chosen, at patternOpacity strength. So \"blue background with stripes\" = wallpaper custom + wallpaperColor blue + wallpaperPattern stripes.",
    "",
    "Bind each part of the instruction to the thing it actually describes: in \"white background with blue bubbles\", white is the background and blue is bubbleColorOutgoing — do not collapse them into one change. Keep text readable against whatever bubble and background colors you choose.",
    "",
    'Slots (each action has the shape {"component": name, "on": "incoming"|"outgoing"|"all", "props": {...optional}}):',
    ...slotLines,
    "",
    "The full spec shape is:",
    '{"version":1,"theme":{...all 17 tokens...},"slots":{"messageActions":[],"composerActions":[],"headerActions":[]}}',
    "",
    "Start from the current spec the user provides, apply the instruction, and keep everything else unchanged.",
    "Return ONLY the full updated spec as raw JSON. No code, no markdown, no commentary.",
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
  let candidate: unknown;
  try {
    candidate = extractJson(data.raw);
  } catch {
    return { status: "invalid", error: "model response was not valid JSON" };
  }
  const validated = validateSpec(candidate);
  if (!validated.ok) {
    return { status: "invalid", error: validated.error };
  }
  return { status: "ok", spec: validated.spec };
}

export interface GenerateResult {
  spec: Spec;
  summary: string;
  matched: boolean;
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
    return { spec: modelResult.spec, summary: "updated (via Claude)", matched: true };
  }

  if (modelResult.status === "ok" || modelResult.status === "invalid") {
    const escalated = await callModel(trimmed, current, ESCALATION_MODEL);
    if (escalated.status === "ok" && !specsEqual(escalated.spec, current)) {
      return { spec: escalated.spec, summary: "updated (via Claude, escalated)", matched: true };
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
