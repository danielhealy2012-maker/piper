// LIVE end-to-end check of the two-stage theme pipeline. Makes real API calls
// against a running local proxy (`npm run proxy`), so it is NOT part of
// `npm run check` — run it deliberately:
//
//   npm run proxy            # terminal 1
//   npm run check:live       # terminal 2
//
// scripts/check-prompts.mjs proves the prompt still SAYS the right things.
// This proves the model still DOES the right things when given the narrowed
// prompt — the distinction this project keeps getting bitten by. Stage 1
// checks that instructions classify into the mechanisms they need; stage 2
// feeds each narrowed prompt to the real generation endpoint and asserts the
// returned spec actually contains the mechanism (a component, an onLoad
// effect, @keyframes), not just that it validated.
//
// An instruction classified as needing FEWER mechanisms than it does is the
// failure that matters — the mechanism's instructions get withheld and the
// model can't do the thing. Extra flags only cost a little context, so they
// are reported but not treated as failures.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = await mkdtemp(join(ROOT, "node_modules", ".piper-live-"));
const outfile = join(dir, "e.mjs");
await build({
  stdin: {
    contents: `export * from "./src/engine/genres";
      export { buildClassifierPrompt } from "./src/engine/classify";
      export { buildSystemPrompt } from "./src/engine/generate";
      export { DEFAULT_SPEC, validateSpec } from "./src/engine/spec";`,
    resolveDir: ROOT,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  external: ["react", "react-dom", "react-dom/server", "@babel/standalone", "@supabase/supabase-js"],
  define: { "import.meta.env": "{}" },
});
const M = await import(pathToFileURL(outfile).href);
await rm(dir, { recursive: true, force: true });

const BASE = process.env.PIPER_PROXY_URL || `http://localhost:${process.env.PIPER_PROXY_PORT || 8787}`;
const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const parse = (raw) => JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));

// [instruction, expected genres]
const CASES = [
  ["make my bubbles green", []],
  ["dark background with a serif font", []],
  ["hide the timestamps and make the bubbles bigger", []],
  ["give my bubbles a neon glow", ["customCSS"]],
  ["make my bubbles pulse gently", ["animation"]],
  ["pop confetti when I receive a message", ["reactiveEffect"]],
  ["a little snake that slithers around the screen all the time", ["ambientEffect"]],
  ["add a tic-tac-toe game we can play", ["interactiveComponent"]],
  ["insert a 5 minute timer", ["interactiveComponent"]],
  ["make the background a cartoon dog", ["imageGeneration"]],
  ["glowing bubbles that also pulse", ["customCSS", "animation"]],
  ["remove the tic-tac-toe game", ["interactiveComponent"]],
];

const classifierSystem = M.buildClassifierPrompt();
console.log("\n--- STAGE 1: classification ---\n");
let miss = 0;
const results = [];
for (const [instruction, expected] of CASES) {
  const { raw } = await post("/api/classify", { system: classifierSystem, instruction });
  const got = parse(raw).genres ?? [];
  const expSet = new Set(expected);
  const gotSet = new Set(got);
  const missing = expected.filter((e) => !gotSet.has(e));
  const extra = got.filter((x) => !expSet.has(x));
  const pass = missing.length === 0;
  if (!pass) miss++;
  results.push({ instruction, got });
  console.log(
    `${pass ? "✓" : "✗"} ${instruction}\n    expected [${expected.join(", ")}]  got [${got.join(", ")}]` +
      (missing.length ? `  MISSING: ${missing.join(", ")}` : "") +
      (extra.length ? `  (extra: ${extra.join(", ")})` : ""),
  );
}
console.log(`\n${CASES.length - miss}/${CASES.length} classified with everything they needed`);

// --- STAGE 2: does the narrowed prompt still produce the right mechanism? ---
console.log("\n--- STAGE 2: generation with the narrowed prompt ---\n");
const STAGE2 = [
  ["make my bubbles green", (s) => s.theme.bubbleColorOutgoing.toLowerCase() !== "#0a84ff", "changed the bubble color"],
  ["add a tic-tac-toe game we can play", (s) => s.customComponents.length > 0, "produced a customComponent"],
  ["pop confetti when I receive a message", (s) => !!s.customEffects.onMessageReceived, "produced an onMessageReceived effect"],
  ["a little snake that slithers around the screen all the time", (s) => !!s.customEffects.onLoad, "produced an onLoad effect"],
  ["make my bubbles pulse gently", (s) => !!s.customCSSText, "produced @keyframes"],
];
for (const [instruction, assert, label] of STAGE2) {
  const genres = M.expandGenres(results.find((r) => r.instruction === instruction).got);
  const system = M.buildSystemPrompt(genres);
  const { raw } = await post("/api/generate", { system, instruction, spec: M.DEFAULT_SPEC });
  const env = parse(raw);
  const v = M.validateSpec(env.spec);
  if (!v.ok) {
    console.log(`✗ ${instruction}\n    spec INVALID: ${v.error}`);
    continue;
  }
  const good = assert(v.spec);
  console.log(
    `${good ? "✓" : "✗"} ${instruction}\n    prompt=${system.length} chars, genres=[${[...genres].join(", ")}] — ${good ? label : "DID NOT " + label}` +
      (env.limitation ? `\n    limitation: ${env.limitation}` : ""),
  );
}
