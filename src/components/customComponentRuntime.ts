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

/** Every prop a compiled component is handed. `sharedState`/`setSharedState`
 *  are present for personal components too, backed by ordinary local state —
 *  a uniform prop contract means a component the model marked personal but
 *  wrote against sharedState degrades to "works, just doesn't sync" instead
 *  of crashing on an undefined function. */
export interface CustomComponentProps {
  messages: unknown[];
  viewerId: string;
  sendMessage: (text: string) => void;
  sharedState: unknown;
  setSharedState: (next: unknown) => void;
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
): ComponentType<CustomComponentProps> {
  // Defensive strip: the model is told never to use export/import, but a
  // stray `export default` would otherwise be a SyntaxError inside
  // `new Function`'s body (which can't contain top-level module syntax).
  const cleaned = code.replace(/^\s*export\s+default\s+/, "").replace(/^\s*export\s+/, "");

  let transformed: string;
  try {
    // runtime: "classic" is required, not optional — this project's
    // @babel/standalone is v8, where preset-react defaults to the
    // "automatic" JSX runtime (emits calls to an `_jsx` helper it expects to
    // import from "react/jsx-runtime"). We provide React itself as a plain
    // argument below, not a module the compiled code can import from, so
    // automatic-runtime output would reference an undefined `_jsx` and throw
    // — not at compile time (the transform succeeds either way), only when
    // the component actually renders. Forcing "classic" guarantees
    // React.createElement calls instead, matching what's actually provided.
    transformed = babel.transform(cleaned, { presets: [["react", { runtime: "classic" }]] }).code ?? "";
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
  return built as ComponentType<CustomComponentProps>;
}
