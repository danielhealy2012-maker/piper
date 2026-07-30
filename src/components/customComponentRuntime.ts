import type { ComponentType } from "react";
import React, { useEffect, useRef, useState } from "react";

// Loaded on demand, not at app startup — most users never trigger a custom
// component, so this (a real JS compiler) shouldn't cost anyone anything.
let babelModulePromise: Promise<typeof import("@babel/standalone")> | null = null;
function loadBabel() {
  if (!babelModulePromise) babelModulePromise = import("@babel/standalone");
  return babelModulePromise;
}

/** Null while Babel is still loading (first custom component on the page). */
export function useBabel(): typeof import("@babel/standalone") | null {
  const [babel, setBabel] = useState<typeof import("@babel/standalone") | null>(null);
  useEffect(() => {
    let alive = true;
    void loadBabel().then((mod) => {
      if (alive) setBabel(mod);
    });
    return () => {
      alive = false;
    };
  }, []);
  return babel;
}

/**
 * Compiles model-authored source into a real React component. Contract with
 * the model (see generate.ts's system prompt): the code must define exactly
 * one top-level `function Component(props) { ... }` using JSX, no
 * import/export statements — React and the three hooks below are already in
 * scope. Throws on any compile or contract failure; callers must catch this
 * (see CustomComponentSlot.tsx) — it's the ONLY validation this content gets,
 * matching the customEffects trust posture: safe to run in this browser tab,
 * not inspected for correctness or intent beyond "does it parse."
 */
export function compileCustomComponent(
  babel: typeof import("@babel/standalone"),
  code: string,
): ComponentType<{ messages: unknown[]; viewerId: string; sendMessage: (text: string) => void }> {
  // Defensive strip: the model is told never to use export/import, but a
  // stray `export default` would otherwise be a SyntaxError inside
  // `new Function`'s body (which can't contain top-level module syntax).
  const cleaned = code.replace(/^\s*export\s+default\s+/, "").replace(/^\s*export\s+/, "");

  let transformed: string;
  try {
    transformed = babel.transform(cleaned, { presets: ["react"] }).code ?? "";
  } catch (err) {
    throw new Error(`couldn't parse component code: ${err instanceof Error ? err.message : String(err)}`);
  }

  let factory: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function("React", "useState", "useEffect", "useRef", `${transformed}\nreturn Component;`) as (
      ...args: unknown[]
    ) => unknown;
  } catch (err) {
    throw new Error(`invalid component code: ${err instanceof Error ? err.message : String(err)}`);
  }

  const built = factory(React, useState, useEffect, useRef);
  if (typeof built !== "function") {
    throw new Error('component code did not define a function named "Component"');
  }
  return built as ComponentType<{ messages: unknown[]; viewerId: string; sendMessage: (text: string) => void }>;
}
