import type { CSSProperties } from "react";
import type { Theme } from "../engine/spec";

export function cornerRadius(style: Theme["cornerStyle"]): number {
  switch (style) {
    case "tight":
      return 6;
    case "soft":
      return 14;
    case "round":
      return 20;
    case "pill":
      return 999;
  }
}

export function rowGap(density: Theme["density"]): number {
  switch (density) {
    case "compact":
      return 2;
    case "comfortable":
      return 8;
    case "spacious":
      return 18;
  }
}

export function fontStack(font: Theme["fontFamily"]): string {
  switch (font) {
    case "system":
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    case "rounded":
      // "SF Pro Rounded"/ui-rounded are macOS-only and "Nunito" isn't preinstalled
      // anywhere, so without a real webfont this bucket was invisible on non-Apple
      // systems. "Quicksand" is loaded via a Google Fonts <link> in index.html.
      return '"Quicksand", "SF Pro Rounded", "Nunito", ui-rounded, "Segoe UI", sans-serif';
    case "mono":
      return '"SF Mono", "Menlo", "Consolas", monospace';
    case "serif":
      return '"New York", "Georgia", "Times New Roman", serif';
  }
}

type WallpaperTheme = Pick<
  Theme,
  | "wallpaper"
  | "wallpaperColor"
  | "gradientFrom"
  | "gradientVia"
  | "gradientTo"
  | "gradientAngle"
  | "wallpaperImage"
  | "wallpaperPattern"
  | "patternOpacity"
>;

interface Layer {
  image?: string;
  size: string;
  repeat: string;
  position: string;
}

// The base layer (solid / gradient / illustrated scene / legacy preset).
function baseLayer(theme: WallpaperTheme): { color: string; layer: Layer | null } {
  switch (theme.wallpaper) {
    case "none":
      return { color: "#ffffff", layer: null };
    case "custom":
      return { color: theme.wallpaperColor, layer: null };
    case "gradient":
      return {
        color: theme.gradientFrom,
        layer: {
          image: `linear-gradient(${theme.gradientAngle}deg, ${theme.gradientFrom} 0%, ${theme.gradientVia} 50%, ${theme.gradientTo} 100%)`,
          size: "cover",
          repeat: "no-repeat",
          position: "center",
        },
      };
    case "image":
      if (theme.wallpaperImage === "none") return { color: "#ffffff", layer: null };
      return {
        color: "#ffffff",
        layer: {
          image: `url(/wallpapers/${theme.wallpaperImage}.svg)`,
          size: "cover",
          repeat: "no-repeat",
          position: "center",
        },
      };
    case "dots":
      return {
        color: "#fafafa",
        layer: {
          image: "radial-gradient(circle, #d8d8dc 1px, transparent 1px)",
          size: "16px 16px",
          repeat: "repeat",
          position: "0 0",
        },
      };
    case "grid":
      return {
        color: "#fcfcfc",
        layer: {
          image:
            "linear-gradient(#e5e5ea 1px, transparent 1px), linear-gradient(90deg, #e5e5ea 1px, transparent 1px)",
          size: "20px 20px, 20px 20px",
          repeat: "repeat, repeat",
          position: "0 0, 0 0",
        },
      };
    case "sunset":
      return {
        color: "#ff9a56",
        layer: {
          image: "linear-gradient(160deg, #ff9a56 0%, #ff6a88 45%, #a86bd8 100%)",
          size: "cover",
          repeat: "no-repeat",
          position: "center",
        },
      };
    case "ocean":
      return {
        color: "#4a90d9",
        layer: {
          image: "linear-gradient(160deg, #7fd8ff 0%, #4a90d9 55%, #2b5876 100%)",
          size: "cover",
          repeat: "no-repeat",
          position: "center",
        },
      };
    case "charcoal":
      return {
        color: "#1c1c1e",
        layer: {
          image: "linear-gradient(160deg, #2c2c2e 0%, #1c1c1e 100%)",
          size: "cover",
          repeat: "no-repeat",
          position: "center",
        },
      };
  }
}

// The pattern overlay composites above whatever base was chosen, so "blue
// background with dots" is expressible — previously dots forced its own fixed
// grey-on-white and nothing could sit under it.
function patternLayer(theme: WallpaperTheme, dark: boolean): Layer | null {
  if (theme.wallpaperPattern === "none" || theme.patternOpacity <= 0) return null;
  const rgb = dark ? "255,255,255" : "0,0,0";
  const ink = `rgba(${rgb},${theme.patternOpacity})`;
  switch (theme.wallpaperPattern) {
    case "dots":
      return {
        image: `radial-gradient(circle, ${ink} 1.5px, transparent 1.5px)`,
        size: "16px 16px",
        repeat: "repeat",
        position: "0 0",
      };
    case "grid":
      return {
        image: `linear-gradient(${ink} 1px, transparent 1px), linear-gradient(90deg, ${ink} 1px, transparent 1px)`,
        size: "20px 20px, 20px 20px",
        repeat: "repeat, repeat",
        position: "0 0, 0 0",
      };
    case "stripes":
      return {
        image: `repeating-linear-gradient(45deg, ${ink} 0 6px, transparent 6px 16px)`,
        size: "auto",
        repeat: "repeat",
        position: "0 0",
      };
    case "checks":
      return {
        image: `conic-gradient(${ink} 0deg 90deg, transparent 90deg 180deg, ${ink} 180deg 270deg, transparent 270deg 360deg)`,
        size: "24px 24px",
        repeat: "repeat",
        position: "0 0",
      };
    case "crosshatch":
      return {
        image: `repeating-linear-gradient(45deg, ${ink} 0 1px, transparent 1px 12px), repeating-linear-gradient(-45deg, ${ink} 0 1px, transparent 1px 12px)`,
        size: "auto, auto",
        repeat: "repeat, repeat",
        position: "0 0, 0 0",
      };
  }
}

export function wallpaperStyle(theme: WallpaperTheme): CSSProperties {
  const base = baseLayer(theme);
  const pattern = patternLayer(theme, isDarkWallpaper(theme));
  const layers = [pattern, base.layer].filter((l): l is Layer => l !== null && Boolean(l.image));
  if (layers.length === 0) {
    return { backgroundColor: base.color };
  }
  return {
    backgroundColor: base.color,
    backgroundImage: layers.map((l) => l.image).join(", "),
    backgroundSize: layers.map((l) => l.size).join(", "),
    backgroundRepeat: layers.map((l) => l.repeat).join(", "),
    backgroundPosition: layers.map((l) => l.position).join(", "),
  };
}

function hexLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Illustrated scenes whose overall tone is dark enough to need light chrome.
const DARK_SCENES = new Set(["mountains", "city", "aurora", "bokeh"]);

export function isDarkWallpaper(
  theme: Pick<
    Theme,
    | "wallpaper"
    | "wallpaperColor"
    | "gradientFrom"
    | "gradientVia"
    | "gradientTo"
    | "wallpaperImage"
  >,
): boolean {
  switch (theme.wallpaper) {
    case "charcoal":
    case "ocean":
      return true;
    case "custom":
      return hexLuminance(theme.wallpaperColor) < 0.5;
    case "gradient": {
      // Average the three stops — a gradient is "dark" if the whole sweep is.
      const mean =
        (hexLuminance(theme.gradientFrom) +
          hexLuminance(theme.gradientVia) +
          hexLuminance(theme.gradientTo)) /
        3;
      return mean < 0.5;
    }
    case "image":
      return DARK_SCENES.has(theme.wallpaperImage);
    default:
      return false;
  }
}

const UPBEAT_RE = /(!|😂|🎉|❤️|great|nice|perfect|love|awesome)/i;
const QUESTIONING_RE = /(\?|not sure|maybe|issue|wrong|problem)/i;

export function sentimentColor(text: string): string {
  if (UPBEAT_RE.test(text)) return "#ff9500";
  if (QUESTIONING_RE.test(text)) return "#0a84ff";
  return "#34c759";
}

export function bubbleStyle(theme: Theme, outgoing: boolean): CSSProperties {
  const radius = cornerRadius(theme.cornerStyle);
  // All four corners are set as LONGHAND properties. Mixing the `borderRadius`
  // shorthand with a single-corner override (which the tail needs) makes React
  // warn on every re-render and can genuinely drop the override.
  const tail = theme.bubbleTail ? 4 : radius;
  const style: CSSProperties = {
    background: outgoing ? theme.bubbleColorOutgoing : theme.bubbleColorIncoming,
    color: outgoing ? theme.textColorOutgoing : theme.textColorIncoming,
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: outgoing ? radius : tail,
    borderBottomRightRadius: outgoing ? tail : radius,
    fontSize: `${theme.bubbleScale}rem`,
    padding: `${0.5 * theme.bubbleScale}rem ${0.85 * theme.bubbleScale}rem`,
    display: "inline-block",
    maxWidth: "100%",
    overflowWrap: "break-word",
    whiteSpace: "normal",
  };
  return style;
}
