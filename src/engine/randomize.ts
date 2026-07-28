import {
  BUBBLE_BORDER_STYLES,
  CORNER_STYLES,
  DENSITIES,
  FONT_FAMILIES,
  SEND_BUTTON_STYLES,
  WALLPAPERS,
  WALLPAPER_IMAGES,
  WALLPAPER_PATTERNS,
} from "./registry";
import { enforceLegibility } from "./legibility";
import type { Spec } from "./spec";

const COLOR_POOL = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#30b0c7", "#0a84ff",
  "#5e5ce6", "#af52de", "#ff2d55", "#a2845e", "#8e8e93", "#1c1c1e", "#ffffff",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * A real randomize: instant, free, client-side, and different every call.
 * Replaces asking the model for "a random colorful fun theme", which cost a
 * network round trip for something that should be instant, tended to
 * converge on similar-looking results run to run (the model has taste, which
 * is the opposite of random), and could silently no-op with no explanation
 * if that call failed to produce a novel spec.
 */
export function randomizeSpec(current: Spec): Spec {
  const wallpaper = pick(WALLPAPERS);
  const next: Spec = {
    ...current,
    theme: {
      ...current.theme,
      bubbleColorOutgoing: pick(COLOR_POOL),
      bubbleColorIncoming: pick(COLOR_POOL),
      textColorOutgoing: pick(["#ffffff", "#111111"] as const),
      textColorIncoming: pick(["#ffffff", "#111111"] as const),
      accentColor: pick(COLOR_POOL),
      bubbleScale: pick([0.9, 1.0, 1.1, 1.2, 1.3] as const),
      cornerStyle: pick(CORNER_STYLES),
      sendButtonStyle: pick(SEND_BUTTON_STYLES),
      fontFamily: pick(FONT_FAMILIES),
      density: pick(DENSITIES),
      wallpaper,
      wallpaperColor: pick(COLOR_POOL),
      gradientFrom: pick(COLOR_POOL),
      gradientVia: pick(COLOR_POOL),
      gradientTo: pick(COLOR_POOL),
      gradientAngle: Math.floor(Math.random() * 360),
      wallpaperImage:
        wallpaper === "image"
          ? pick(WALLPAPER_IMAGES.filter((w) => w !== "none"))
          : current.theme.wallpaperImage,
      wallpaperPattern: pick(WALLPAPER_PATTERNS),
      patternOpacity: Math.round(Math.random() * 30) / 100,
      bubbleTail: Math.random() > 0.5,
      bubbleBorderStyle: pick(BUBBLE_BORDER_STYLES),
      bubbleBorderWidth: Math.floor(Math.random() * 5),
      bubbleBorderColor: pick(COLOR_POOL),
      sentimentTint: Math.random() > 0.5,
      showAvatars: Math.random() > 0.3,
      showTimestamps: Math.random() > 0.3,
    },
  };
  // Random color pairings can land on poor contrast — same safety net used
  // for model-generated specs.
  return enforceLegibility(next);
}
