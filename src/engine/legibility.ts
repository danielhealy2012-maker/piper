import type { Spec } from "./spec";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHex = (v: string | undefined): v is string => !!v && HEX_RE.test(v);

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

function bestTextColor(bgHex: string): string {
  return contrastRatio(bgHex, "#ffffff") > contrastRatio(bgHex, "#000000") ? "#ffffff" : "#000000";
}

// Below this ratio text reads as genuinely hard to see, not just low-contrast
// by taste — WCAG AA's 4.5 is stricter than a chat bubble needs, so this is
// deliberately lenient and only catches real "can't read it" cases.
const MIN_CONTRAST = 2.5;
// Applied when a shape property (clipPath/mask) has no padding of its own —
// gives the text room to sit inside the shape's silhouette instead of
// bleeding into a corner that gets cut off.
const SAFE_SHAPE_PADDING = "0.85rem 1.2rem";

/**
 * Runs on every model-generated spec before it reaches the DOM. The model can
 * satisfy a request ("cloud-shaped bubble", "green on green") in a way that's
 * visually what was asked for but makes the text hard to read — this corrects
 * that specific failure mode without touching anything the model got right.
 * Corrects in place (auto-fixes text color / adds padding) rather than
 * rejecting, since the user's actual request should still be honored.
 */
export function enforceLegibility(spec: Spec): Spec {
  const next = structuredClone(spec);

  if (contrastRatio(next.theme.bubbleColorOutgoing, next.theme.textColorOutgoing) < MIN_CONTRAST) {
    next.theme.textColorOutgoing = bestTextColor(next.theme.bubbleColorOutgoing);
  }
  if (contrastRatio(next.theme.bubbleColorIncoming, next.theme.textColorIncoming) < MIN_CONTRAST) {
    next.theme.textColorIncoming = bestTextColor(next.theme.bubbleColorIncoming);
  }

  (["bubbleOutgoing", "bubbleIncoming"] as const).forEach((zone) => {
    const css = next.customCSS[zone];
    if (!css) return;

    const bg = css.backgroundColor ?? css.background;
    const fg = css.color ?? (zone === "bubbleOutgoing" ? next.theme.textColorOutgoing : next.theme.textColorIncoming);
    if (isHex(bg) && isHex(fg) && contrastRatio(bg, fg) < MIN_CONTRAST) {
      css.color = bestTextColor(bg);
    }

    // A shape clip with no padding of its own risks slicing straight through
    // the text — this was the actual complaint (cloud-shaped bubble hiding
    // words), not a color problem.
    if ((css.clipPath || css.mask) && !css.padding) {
      css.padding = SAFE_SHAPE_PADDING;
    }
  });

  return next;
}
