// Smoke test for the two-stage theme pipeline's PROMPT ASSEMBLY.
//
// Why this exists: `tsc` proves buildSystemPrompt() returns a string. It does
// not prove the string still contains the instructions the model needs, and
// the whole point of Phase 0 is that those instructions are now conditional.
// A section accidentally gated behind the wrong genre, a dependency that
// stops being expanded, or a new genre that never reaches the classifier
// would all typecheck perfectly and silently make the model dumber — the
// exact failure mode this project keeps hitting ("compiles/validates" is not
// "works").
//
// Run: npm run check
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;

// esbuild needs a single entry to produce a single output file.
async function loadModules() {
  // Built INSIDE the project rather than in os.tmpdir(): the bundle leaves
  // react/supabase external, and node resolves those by walking up from the
  // importing file — from a system temp dir it would never reach this
  // project's node_modules.
  const dir = await mkdtemp(join(ROOT, "node_modules", ".piper-check-"));
  const outfile = join(dir, "engine.mjs");
  await build({
    stdin: {
      contents: `
        export * from "./src/engine/genres";
        export * from "./src/engine/classify";
        export { buildSystemPrompt } from "./src/engine/generate";
        export { buildRouterPrompt } from "./src/engine/actions";
        export { formatHistory } from "./src/engine/history";
        export { DEFAULT_SPEC, validateSpec } from "./src/engine/spec";
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    external: ["react", "react-dom", "react-dom/server", "@babel/standalone", "@supabase/supabase-js"],
    // Vite injects import.meta.env in the browser build; node has no such
    // thing. Prompt assembly doesn't read any of it — an empty object just
    // stops the module-scope reads in supabase.ts/spec.ts from throwing on
    // import.
    define: { "import.meta.env": "{}" },
  });
  const mod = await import(pathToFileURL(outfile).href);
  await rm(dir, { recursive: true, force: true });
  return mod;
}

let failures = 0;
let checks = 0;

function ok(label, condition, detail = "") {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

function group(name) {
  console.log(`\n${name}`);
}

const mod = await loadModules();
const {
  GENRES,
  GENRE_NAMES,
  expandGenres,
  buildSystemPrompt,
  buildClassifierPrompt,
  buildRouterPrompt,
  genresPresentInSpec,
  formatHistory,
  DEFAULT_SPEC,
  validateSpec,
} = mod;

const g = (...names) => new Set(names);

// Distinctive strings that appear ONLY inside one mechanism's block, so their
// presence/absence is a real signal about what the model was told.
const MARKERS = {
  customCSS: "an object keyed by zone",
  animation: "@keyframes` can be defined",
  ambientEffect: "onLoad` is DIFFERENT",
  reactiveEffect: "are ONE-SHOT",
  interactiveComponent: "CODE CONTRACT",
  sharedState: "SHARED STATE",
  imageGeneration: "IMAGE GENERATION:",
};

// -- 1. The base prompt is unconditional -------------------------------------
group("base prompt survives narrowing");
{
  const minimal = buildSystemPrompt(g());
  const alwaysNeeded = [
    ["theme token list", "Theme tokens:"],
    ["background layering rules", "wallpaper` picks the BASE layer"],
    ["the generated-wallpaper guard", '"generated" is NOT a value you can set'],
    ["clause binding rule", "white background with blue bubbles"],
    ["slot catalog", "Slots (each action has the shape"],
    ["legibility rules", "LEGIBILITY IS NON-NEGOTIABLE"],
    ["full spec shape", '"customComponents":['],
    ["response envelope", '"backgroundImagePrompt"'],
    ["honest-limitation rule", "explain honestly in `limitation`"],
  ];
  for (const [label, needle] of alwaysNeeded) {
    ok(`token-only prompt still has ${label}`, minimal.includes(needle));
  }
  ok(
    "token-only prompt tells the model to preserve untouched hatches",
    minimal.includes("echo them back byte-for-byte"),
  );
}

// -- 2. Narrowing actually narrows -------------------------------------------
group("narrowing removes the mechanisms that aren't needed");
{
  const minimal = buildSystemPrompt(g());
  for (const [genre, marker] of Object.entries(MARKERS)) {
    ok(`token-only prompt omits ${genre}`, !minimal.includes(marker));
  }
  const full = buildSystemPrompt(null);
  ok(
    "narrowed prompt is materially smaller than the full one",
    minimal.length < full.length * 0.7,
    `minimal=${minimal.length} full=${full.length} (${Math.round((minimal.length / full.length) * 100)}%)`,
  );
}

// -- 3. Each genre pulls in its own block, and only its own -------------------
group("each genre includes its own mechanism");
for (const genre of GENRE_NAMES) {
  const active = expandGenres([genre]);
  const prompt = buildSystemPrompt(active);
  ok(`${genre} includes its own instructions`, prompt.includes(MARKERS[genre]));
  for (const other of GENRE_NAMES) {
    if (active.has(other)) continue;
    ok(
      `${genre} does not drag in ${other}`,
      !prompt.includes(MARKERS[other]),
      `"${MARKERS[other]}" leaked into the ${genre} prompt`,
    );
  }
}

// -- 4. Dependencies get expanded --------------------------------------------
group("genre dependencies expand");
{
  // An @keyframes block is useless without a customCSS `animation` property to
  // reference it from, and an ambient effect needs both.
  ok("animation implies customCSS", expandGenres(["animation"]).has("customCSS"));
  ok("ambientEffect implies animation", expandGenres(["ambientEffect"]).has("animation"));
  ok("ambientEffect implies customCSS", expandGenres(["ambientEffect"]).has("customCSS"));
  const ambient = buildSystemPrompt(expandGenres(["ambientEffect"]));
  ok("ambient prompt can define keyframes", ambient.includes(MARKERS.animation));
  ok("ambient prompt does not describe one-shot effects", !ambient.includes(MARKERS.reactiveEffect));
}

// -- 5. Both effect genres together keep the contrast warning ----------------
group("the ambient-vs-one-shot contrast is preserved");
{
  const both = buildSystemPrompt(expandGenres(["ambientEffect", "reactiveEffect"]));
  ok("both effect kinds described", both.includes(MARKERS.ambientEffect) && both.includes(MARKERS.reactiveEffect));
  ok(
    "the distinction warning is present when both apply",
    both.includes("falsely report success"),
  );
}

// -- 6. Hatch numbering is contiguous ----------------------------------------
group("assembled hatch list is numbered correctly");
for (const combo of [["customCSS"], ["interactiveComponent"], ["animation"], ["reactiveEffect", "interactiveComponent"]]) {
  const prompt = buildSystemPrompt(expandGenres(combo));
  const numbers = [...prompt.matchAll(/^(\d+)\. `/gm)].map((m) => Number(m[1]));
  const expected = numbers.map((_, i) => i + 1);
  ok(
    `[${combo.join("+")}] hatches numbered 1..n`,
    numbers.length > 0 && JSON.stringify(numbers) === JSON.stringify(expected),
    `got ${JSON.stringify(numbers)}`,
  );
}

// -- 7. Existing spec content is never orphaned ------------------------------
group("current spec content keeps its contract");
{
  ok("a default spec needs no mechanisms", genresPresentInSpec(DEFAULT_SPEC).size === 0);

  const withGame = {
    ...DEFAULT_SPEC,
    customComponents: [
      { id: "ttt", label: "Tic Tac Toe", slot: "standalone", code: "function Component() { return <div/>; }" },
    ],
  };
  const present = genresPresentInSpec(withGame);
  ok("a spec holding a component reports interactiveComponent", present.has("interactiveComponent"));
  // The real risk this guards: "make the background blue" against a spec that
  // holds a game classifies as token-only, and without this union the model
  // would be asked to echo back component source it was never given the
  // contract for — most likely dropping the game.
  const prompt = buildSystemPrompt(expandGenres([...g(), ...present]));
  ok("component contract survives a token-only instruction", prompt.includes(MARKERS.interactiveComponent));

  const withEffect = { ...DEFAULT_SPEC, customEffects: { onLoad: "container.appendChild(document.createElement('div'));" } };
  ok("an onLoad effect reports ambientEffect", genresPresentInSpec(withEffect).has("ambientEffect"));

  const withCss = { ...DEFAULT_SPEC, customCSS: { bubbleOutgoing: { boxShadow: "0 0 8px red" } } };
  ok("custom CSS reports customCSS", genresPresentInSpec(withCss).has("customCSS"));
}

// -- 7b. Shared components carry their own contract ---------------------------
//
// A game marked scope:"personal" is broken by construction — the other person
// can't see the board — and a shared component written against useState shows
// each player only their own moves. Both failures look like working code and
// only surface when a second person opens the chat, so the prompt must state
// the scope rule and the sharedState contract together.
group("shared components get the scope + sync contract");
{
  ok("sharedState implies interactiveComponent", expandGenres(["sharedState"]).has("interactiveComponent"));

  const shared = buildSystemPrompt(expandGenres(["sharedState"]));
  ok("shared prompt explains the scope field", shared.includes('"scope"'));
  ok("shared prompt warns a personal game is broken", shared.includes("broken by construction"));
  ok("shared prompt gives the null-before-first-write rule", shared.includes("null` until the first write"));
  ok("shared prompt warns against mirroring into useState", shared.includes("feedback loop"));

  // The reverse: an ordinary personal widget shouldn't pay for any of this.
  const personalOnly = buildSystemPrompt(expandGenres(["interactiveComponent"]));
  ok("a plain widget prompt omits the sync contract", !personalOnly.includes(MARKERS.sharedState));
  ok("but still describes scope, since every component needs one", personalOnly.includes('"scope"'));

  // The spec skeleton has to show `scope`, or the model omits it and every
  // component silently defaults to personal — including the games.
  ok("spec skeleton shows the scope field", personalOnly.includes('"scope":"personal"|"shared"'));

  const withSharedGame = {
    ...DEFAULT_SPEC,
    customComponents: [
      { id: "ttt", label: "Tic Tac Toe", slot: "standalone", scope: "shared", code: "function Component() { return <div/>; }" },
    ],
  };
  ok(
    "an existing shared component keeps its contract on the next instruction",
    genresPresentInSpec(withSharedGame).has("sharedState"),
  );
}

// -- 7c. Deprecated components aren't offered --------------------------------
//
// `Poll` is a dead mockup that tallies nothing and only its owner can see.
// While the model was offered a component literally named "Poll", it kept
// picking it for "add a poll" — silently substituting something
// non-functional for the thing asked for. It has to stay VALID though, or a
// saved spec containing one would fail validation and reset that user's
// whole theme.
group("deprecated components are hidden but still valid");
{
  const full = buildSystemPrompt(null);
  ok("the dead Poll component is not offered to the model", !full.includes("Poll"));

  const legacy = {
    ...DEFAULT_SPEC,
    slots: {
      ...DEFAULT_SPEC.slots,
      composerActions: [{ component: "Poll", on: "all", props: { question: "Dinner?", options: ["a", "b"] } }],
    },
  };
  const result = validateSpec(legacy);
  ok(
    "a saved spec containing it still validates",
    result.ok,
    result.ok ? "" : `would reset the user's theme: ${result.error}`,
  );
}

// -- 8. The classifier can name every genre ----------------------------------
group("classifier prompt covers every genre");
{
  const prompt = buildClassifierPrompt();
  for (const name of GENRE_NAMES) {
    ok(`classifier knows "${name}"`, prompt.includes(`"${name}"`));
    ok(`classifier explains "${name}"`, prompt.includes(GENRES[name].classifierHint.slice(0, 40)));
  }
  ok("classifier is told an empty array is valid", prompt.includes("EMPTY array"));
}

// -- 9. The router believes every genre is possible --------------------------
//
// This is the bug class that made "insert a timer" and "add a tic-tac-toe
// game" come back as "Piper can't do that": a capability existed, but the
// router had never been told, so it rejected the request before the engine
// that could handle it ever saw it. Any genre added later fails this check
// until the router knows about it.
group("router prompt covers every genre");
{
  const prompt = buildRouterPrompt();
  for (const name of GENRE_NAMES) {
    ok(`router knows about ${name}`, prompt.includes(GENRES[name].routerHint));
  }
  ok("router is told not to reject these", prompt.toLowerCase().includes("never mark"));
}

// -- 10. Conversational memory ------------------------------------------------
group("instruction history");
{
  ok("a fresh session sends no history", formatHistory([]) === null);

  const many = Array.from({ length: 20 }, (_, i) => ({
    instruction: `instruction ${i}`,
    summary: `did ${i}`,
    matched: true,
  }));
  const capped = formatHistory(many);
  // Uncapped, this grows every single request for the whole session.
  ok("history is capped", (capped.match(/user asked:/g) ?? []).length <= 8);
  ok("history keeps the most recent turns", capped.includes("instruction 19"));
  ok("history drops the oldest turns", !capped.includes('"instruction 0"'));

  const mixed = formatHistory([
    { instruction: "make it purple", summary: "bubbles -> purple", matched: true },
    { instruction: "add a xylophone", summary: "couldn't do that one", matched: false },
  ]);
  ok("history records what was asked", mixed.includes("make it purple"));
  ok("history records the outcome", mixed.includes("bubbles -> purple"));
  // "that didn't work, why?" is a follow-up ABOUT a failure — dropping failed
  // turns leaves the model answering with no idea what went wrong.
  ok("failed turns are kept, not filtered", mixed.includes("add a xylophone"));
  ok("failed turns are marked as such", mixed.includes("not applied"));
  // History is past turns quoted into a prompt; without this the model can
  // read an old instruction as a fresh one and re-apply it.
  ok("history is fenced as context, not instructions", mixed.includes("Do NOT re-apply"));

  // Measured per FIELD, not on the whole string — the fixed preamble is ~460
  // chars on its own, so a total-length threshold would say nothing about
  // whether a rambling instruction actually got truncated.
  const long = formatHistory([{ instruction: "x".repeat(500), summary: "y".repeat(500), matched: true }]);
  const longestRun = Math.max(...[...long.matchAll(/x+|y+/g)].map((m) => m[0].length));
  ok("long entries are clipped", longestRun <= 200, `longest field run was ${longestRun}`);
  ok("clipping is marked with an ellipsis", long.includes("…"));
}

console.log(
  `\n${failures === 0 ? "✓" : "✗"} ${checks - failures}/${checks} prompt checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
