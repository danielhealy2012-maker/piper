import {
  COMPONENTS,
  SLOT_NAMES,
  SLOTS,
  THEME_TOKENS,
  isDeprecatedComponent,
  propsSchemaFor,
  type ComponentName,
} from "./registry";
import { DEFAULT_SPEC, specsEqual, validateSpec, type Action, type Spec } from "./spec";
import { enforceLegibility } from "./legibility";
import { apiPost } from "../lib/api";
import { generateBackgroundImage } from "../lib/image";
import { classifyInstruction, genresPresentInSpec } from "./classify";
import { extractJson } from "./json";
import {
  CUSTOM_COMPONENT_SHAPE,
  GENRE_NAMES,
  SPECIALIST_SECTIONS,
  expandGenres,
  hatchNamesFor,
  type Genre,
} from "./genres";

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
  // NO Poll trigger, deliberately. The bundled `Poll` is a static demo: it
  // renders a question and options but tallies nothing and is visible only to
  // its owner. While this trigger existed, the bare phrasing "add a poll" hit
  // the free keyword path and silently got that static one, never reaching
  // the model that can build a real shared poll both people vote in. Letting
  // it cost a model call is the right trade — the model can still choose the
  // static component when that's genuinely all that's wanted.
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
  // "poll"/"polls" deliberately absent, matching the removed Poll trigger
  // above — VOCAB must only list words draft() actually consumes, and leaving
  // them here would let "add a poll" pass the residual gate as fully
  // understood when the stub no longer does anything with it.
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

/**
 * Stage 2 of the theme pipeline: the specialist prompt.
 *
 * `active` is the genre set from the stage-1 classifier (see classify.ts),
 * unioned with whatever the current spec already uses. Only those mechanisms'
 * instruction blocks are included — a plain "make my bubbles green" no longer
 * carries the component code contract, the effects examples, and the image
 * generation rules it will never use.
 *
 * Passing null (or nothing) restores the old every-mechanism mega-prompt. That
 * is the deliberate fallback for a failed classifier call and for the
 * escalation retry, so a misclassification degrades to "as good as before"
 * rather than to "can't do it".
 */
export function buildSystemPrompt(genres?: Set<Genre> | null): string {
  const active = genres ?? new Set<Genre>(GENRE_NAMES);
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

  // Deprecated components are filtered out of what the model is OFFERED,
  // while staying valid for specs that already contain them — see
  // DEPRECATED_COMPONENTS in registry.ts.
  const slotLines = SLOT_NAMES.map(
    (slot) =>
      `- ${slot} — ${SLOTS[slot].label}. Allowed components: ${SLOTS[slot].allow
        .filter((c) => !isDeprecatedComponent(c))
        .join(", ")}.`,
  );

  const sectionsFor = (at: "hatches" | "tail") =>
    SPECIALIST_SECTIONS.filter((s) => s.at === at && s.needs.some((n) => active.has(n)));

  // The hatch list is numbered for the model's benefit, but WHICH hatches are
  // present varies per request now — so number them at assembly time rather
  // than hardcoding "1./2./3./4." into text that may not all be there.
  const hatchLines = sectionsFor("hatches").flatMap((section, i) =>
    section.build(active).map((line, j) => (j === 0 ? `${i + 1}. ${line}` : line)),
  );

  const hatchBlock =
    hatchLines.length > 0
      ? [
          "",
          "ESCAPE HATCHES — for the parts of this request the token list above can't express. Use these INSTEAD of forcing a request into a token that doesn't really fit.",
          "",
          ...hatchLines,
        ]
      : [];

  // The envelope always carries this key so the client parser stays uniform,
  // but when image generation isn't in play the model is told plainly that
  // null is the only valid value — rather than left with a dangling reference
  // to a section that wasn't included.
  const backgroundImagePromptSpec = active.has("imageGeneration")
    ? "<string|null — a generation prompt as described above, or null>"
    : "null (always null for this request — image generation is not part of it)";

  const hatchNames = hatchNamesFor(active);
  const closingGuidance =
    hatchNames.length > 0
      ? `Use the token list for anything it already covers (colors, fonts, corner style, tail, borders, backgrounds) — it's simpler and cheaper. Reach for the escape hatches only where the request genuinely needs what they provide, and prefer the SIMPLEST one that satisfies it (${hatchNames.join(" over ")}). Leave any customCSS zones / customCSSText / customEffects keys / customComponents you're not touching as empty/null/unchanged rather than guessing values for them.`
      : "This request has been assessed as expressible with the theme tokens above, so no escape-hatch mechanisms are described here. Leave customCSS, customCSSText, customEffects and customComponents exactly as they arrive in the current spec — echo them back byte-for-byte, never blank them out. If the request truly cannot be done with the tokens, say so in `limitation` rather than inventing a mechanism.";

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
    '- NOTE: "generated" is NOT a value you can set for `wallpaper`, ever, and you never set `wallpaperUrl` either — both are reserved for the system to fill in on its own after a real image has been generated. Always pick one of the values above instead.',
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
    '- ToneShifter: {"tones": [array from "formal","casual","warm","concise"]}',
    '- ThemeBadge: {"text": string, max 24 chars}',
    "",
    ...hatchBlock,
    "",
    "LEGIBILITY IS NON-NEGOTIABLE. Every message must stay fully readable after your change — never let a shape, clip, mask, texture, or color combination cover, crop, or wash out the text. Concretely:",
    '- If you touch `color` or the bubble\'s background anywhere (token or customCSS), keep them at strong contrast (dark text on light backgrounds, light text on dark ones).',
    '- For unusual bubble SHAPES (e.g. "cloud-shaped", "blob-shaped"), prefer an irregular `borderRadius` (e.g. "255px 15px 225px 15px / 15px 225px 15px 255px") or layered `boxShadow` "puffs" around the edge — these read as soft/rounded/cloud-like without ever touching the interior where the text sits. AVOID `clipPath` for bubble shapes: a clip-path crops the box itself, and an imprecise polygon (the usual failure mode) slices straight through letters. If you do use `clipPath`, keep it in the outer ~15% margin of the box and set generous padding (at least "0.85rem 1.2rem") so the entire text area sits inside the untouched center.',
    "- Never set an animation that moves, rotates, or fades the text itself to the point of unreadability — animate a border, glow, or background instead of the bubble's content box when in doubt.",
    "",
    closingGuidance,
    "",
    "The full spec shape is:",
    `{"version":1,"theme":{...all 20 tokens...},"slots":{"messageActions":[],"composerActions":[],"headerActions":[]},"customCSSText":"","customCSS":{"bubbleOutgoing":{},"bubbleIncoming":{},"background":{},"header":{}},"customEffects":{"onLoad":null,"onMessageReceived":null,"onMessageSent":null,"onReaction":null},"customComponents":[${CUSTOM_COMPONENT_SHAPE}]}`,
    "",
    "Start from the current spec the user provides, apply the instruction, and keep everything else unchanged.",
    "",
    ...sectionsFor("tail").flatMap((s) => s.build(active)),
    "",
    "Where this registry still can't fully satisfy the request, pick the best available approximation and explain honestly in `limitation` rather than silently substituting — e.g. an out-of-scope request for real audio, a data type nothing here can represent, etc.",
    "",
    "Output a JSON OBJECT with exactly these keys — not the bare spec:",
    `{"spec": {...the full spec, shape above...}, "summary": <short phrase describing what you actually changed, e.g. "set background to a green forest scene">, "limitation": <string|null — null if you fully did what was literally asked; otherwise ONE sentence explaining what you couldn't do and what you did instead>, "backgroundImagePrompt": ${backgroundImagePromptSpec}}`,
    "",
    "Return ONLY that JSON object. No markdown, no commentary outside the object.",
  ].join("\n");
}

async function callModel(
  instruction: string,
  current: Spec,
  genres: Set<Genre> | null,
  history: string | null,
  model?: string,
): Promise<ModelResult> {
  let res: Response;
  try {
    res = await apiPost("/api/generate", {
      system: buildSystemPrompt(genres),
      instruction,
      spec: current,
      history,
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
      // sharedState is deliberately null here — that's its real value before
      // anyone has written to it, so this smoke test also catches the very
      // common "read .foo off sharedState without a null guard" crash, which
      // would otherwise only surface on the first render of a brand-new
      // shared widget.
      ReactDOMServer.renderToStaticMarkup(
        React.createElement(Comp, {
          messages: [],
          viewerId: "",
          sendMessage: () => {},
          sharedState: null,
          setSharedState: () => {},
          appendSharedState: () => {},
        }),
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
  history?: string | null,
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

  // Stage 1: which mechanisms does this request actually need? null means the
  // classifier was unavailable — callModel then builds the old full prompt, so
  // this is an accuracy improvement, never a new point of failure.
  //
  // Unioned with the genres the CURRENT spec already uses: the specialist has
  // to echo the whole spec back, and it can only do that faithfully for
  // mechanisms whose contract it was actually given.
  const classified = await classifyInstruction(trimmed);
  const present = genresPresentInSpec(current);
  const genres = classified === null ? null : expandGenres([...classified, ...present]);

  const modelResult = await callModel(trimmed, current, genres, history ?? null, model);

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
    // The escalation retry deliberately passes `null` for genres: it uses the
    // FULL every-mechanism prompt, not the narrowed one. A no-op result is
    // exactly the symptom a misclassification produces (the request needed a
    // mechanism whose instructions were withheld), so retrying with the same
    // narrow prompt would reliably fail the same way. This is what keeps a
    // classifier miss a slower answer rather than a wrong one.
    const escalated = await callModel(trimmed, current, null, history ?? null, ESCALATION_MODEL);
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
