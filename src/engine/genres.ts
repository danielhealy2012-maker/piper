// ---------------------------------------------------------------------------
// The GENRE catalog — the single source of truth for "what kinds of thing can a
// themeInstruction produce".
//
// Three separate consumers used to each carry their own hand-written copy of
// this knowledge, and they drifted apart every time a capability was added:
//   1. the ROUTER prompt (actions.ts), which rejects requests it doesn't
//      believe are possible — the bug that made "insert a timer" and "add a
//      tic-tac-toe game" come back as "Piper can't do that",
//   2. the CLASSIFIER prompt (classify.ts), stage 1 of theme generation,
//   3. the SPECIALIST prompt (generate.ts's buildSystemPrompt), stage 2.
// They all read this file now, so adding a capability is one entry here rather
// than three edits that have to be remembered in three places.
//
// `specialistSections` below is the other half of the Phase 0 rearchitecture:
// buildSystemPrompt() assembles ONLY the mechanism blocks the classifier said
// are relevant, instead of one mega-prompt holding every mechanism's
// instructions at once for every request.
// ---------------------------------------------------------------------------

export interface GenreDef {
  /** Shown to the stage-1 classifier: when does this flag apply? */
  classifierHint: string;
  /** Shown to the router as proof the capability exists, so it never rejects
   *  a request of this kind as unsupported. */
  routerHint: string;
}

export const GENRES = {
  customCSS: {
    classifierHint:
      'the look needs something the fixed theme tokens (colors, fonts, corner style, density, background) cannot express on their own — unusual bubble shapes, glows, shadows, outlines, textures, blurs, opacity tricks.',
    routerHint: "unusual bubble shapes, glows, shadows, borders, textures",
  },
  animation: {
    classifierHint:
      'something should MOVE or change continuously as part of its styling — pulsing, wobbling, shimmering, breathing, spinning, gradient shifting.',
    routerHint: 'animations — "make my bubbles pulse", shimmering, wobbling',
  },
  ambientEffect: {
    classifierHint:
      'something decorative should be present or moving CONTINUOUSLY on the screen, with no natural end and no particular trigger — "a snake that slithers around", "floating bubbles", "snow always falling", "stars drifting".',
    routerHint: 'ambient, always-on decoration — "snow falling in the background", "a fish swimming around"',
  },
  reactiveEffect: {
    classifierHint:
      'something should happen ONCE, in response to a specific event — sending a message, receiving one, or reacting. "confetti when I get a message", "flash the screen on a reaction". Do NOT use this for anything that needs to know the TRUE running message count or conversation history (e.g. "celebrate every 100th message", "mark our one-year anniversary of chatting") — a one-shot effect has no memory between firings and no access to the real message list, so it can only fake a counter. Use `interactiveComponent` instead for those, since it receives the real `messages` array.',
    routerHint: 'one-shot effects on an event — "pop confetti when I receive a message", "flash on a reaction"',
  },
  interactiveComponent: {
    classifierHint:
      'the request needs a real WIDGET with its own state and behavior, not just styling or a one-shot effect — a timer, a counter, a calculator, a mini-game (tic-tac-toe, trivia), a to-do list, a scoreboard, any ongoing UI the user can interact with. Also use this flag for removing or modifying a widget that already exists. This is also the right flag for anything gated on the TRUE message count or history — "celebrate every 100th message", "streak tracker", "one year since we started" — because only a component receives the real `messages` array/timestamps; a one-shot effect (reactiveEffect) cannot count accurately across events.',
    routerHint:
      'real interactive widgets with their own state — timers, counters, calculators, mini-games (including tic-tac-toe), to-do lists, scoreboards, streak/milestone trackers based on real message counts, and removing/modifying ones already added',
  },
  sharedState: {
    classifierHint:
      'the widget is something BOTH people use together, where each person needs to see what the other did — a two-player game, a shared to-do list, a live poll with real tallied votes, a collaborative whiteboard, a shared counter or scoreboard. The giveaway is language like "we", "us", "together", "each other", "both of us", or any game/list/vote that would be pointless if only one person could see it.',
    routerHint:
      'shared, live-synced widgets both people can use at once — two-player games, shared to-do lists, live polls with real votes, collaborative drawing',
  },
  imageGeneration: {
    classifierHint:
      'the background is described as real pictorial artwork that the 8 bundled illustrated scenes cannot cover — a specific animal, character, object, place, or art style ("a cartoon dog", "watercolor mountains", "pixel art city").',
    routerHint: 'AI-generated background artwork — "a cartoon dog background", "watercolor waves"',
  },
} as const satisfies Record<string, GenreDef>;

export type Genre = keyof typeof GENRES;

export const GENRE_NAMES = Object.keys(GENRES) as Genre[];

export function isGenre(value: unknown): value is Genre {
  return typeof value === "string" && (GENRE_NAMES as string[]).includes(value);
}

// Some genres can't be expressed without another one's mechanism: an animation
// is defined in customCSSText (@keyframes) but has to be REFERENCED from a
// customCSS `animation` property, so classifying something as "animation"
// alone would hand the model half a mechanism.
const IMPLIES: Partial<Record<Genre, Genre[]>> = {
  animation: ["customCSS"],
  ambientEffect: ["animation", "customCSS"],
  // Shared state is a property OF a component — there's nothing else it can
  // attach to, so the component contract always comes with it.
  sharedState: ["interactiveComponent"],
};

/** Expands a classified genre set with everything those genres depend on. */
export function expandGenres(genres: Iterable<Genre>): Set<Genre> {
  const out = new Set<Genre>();
  const visit = (g: Genre) => {
    if (out.has(g)) return;
    out.add(g);
    for (const dep of IMPLIES[g] ?? []) visit(dep);
  };
  for (const g of genres) visit(g);
  return out;
}

// ---------------------------------------------------------------------------
// Specialist prompt sections. Each entry fires when ANY of its `needs` genres
// is active. Grouped rather than one-section-per-genre because customEffects'
// two genres (ambient vs reactive) share a preamble and are only meaningful in
// contrast with each other — that contrast is exactly what a real bug came
// from, so it stays in one block whenever either is in play.
// ---------------------------------------------------------------------------

export interface SpecialistSection {
  needs: Genre[];
  /** Where in the assembled prompt this block belongs: inside the numbered
   *  escape-hatch list, or as its own trailing section after the spec shape. */
  at: "hatches" | "tail";
  build: (active: Set<Genre>) => string[];
}

export const SPECIALIST_SECTIONS: SpecialistSection[] = [
  {
    at: "hatches",
    needs: ["customCSS"],
    build: () => [
      '`customCSS` — an object keyed by zone: "bubbleOutgoing", "bubbleIncoming", "background", "header". Each zone\'s value is an object of real CSS properties in camelCase (React inline-style syntax, e.g. "backgroundColor", "clipPath", "boxShadow", "border", "filter", "animation"), with plain string values. This is how you do things tokens can\'t: glows, custom borders beyond the border tokens, textured backgrounds, unusual shapes, etc. These merge on TOP of the theme tokens — you don\'t need to also set the token version of something you\'re overriding here.',
    ],
  },
  {
    at: "hatches",
    needs: ["animation"],
    build: () => [
      '`customCSSText` — a string of raw CSS, injected verbatim in a <style> tag. This is the ONLY place `@keyframes` can be defined. If you want an animated bubble (pulse, wobble, wiggle), define the `@keyframes` here and reference the animation by name in customCSS\'s `animation` property for the relevant zone.',
      '   - ANIMATED BACKGROUNDS specifically: never write `@keyframes` steps that change `background`/`background-image` to a DIFFERENT gradient string at each step (e.g. 0% one `linear-gradient(...)`, 50% a different one) — gradients are not a type browsers can smoothly interpolate between, so this either jump-cuts abruptly at each keyframe with no visible motion in between, or doesn\'t animate at all. It looks correct in the JSON and is a common mistake. The correct technique: set ONE gradient with `backgroundSize: "400% 400%"` (larger than the element) in customCSS\'s `background` zone, then `@keyframes` that only moves `background-position` (a genuinely interpolatable property) between corners, e.g. `0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; }`, referenced via `animation: <name> 8s ease infinite` on that same zone. This is the ONLY reliable way to make a gradient background appear to shift/move.',
    ],
  },
  {
    at: "hatches",
    needs: ["ambientEffect", "reactiveEffect"],
    build: (active) => {
      const lines = [
        '`customEffects` — an object with optional keys "onLoad", "onMessageReceived", "onMessageSent", "onReaction", each a STRING of plain JavaScript (a function body, not a full function), with one variable available: `container`, a real DOM element positioned over the whole chat. ALWAYS use `container.appendChild(...)` — never `document.body.appendChild(...)`, which escapes the chat entirely and can render outside the visible chat panel where it\'s easy to miss or looks broken.',
      ];
      if (active.has("reactiveEffect")) {
        lines.push(
          "   - `onMessageReceived`/`onMessageSent`/`onReaction` are ONE-SHOT: the code runs once when that specific event happens, then should clean up after itself (setTimeout to remove what it created). Use these for something tied to an event — confetti on receive, a flash on reaction. These do NOT run continuously and do NOT run immediately when applied — only the next time that event actually occurs.",
          '   - Example onMessageReceived value (one-shot, event-triggered): "for (let i = 0; i < 20; i++) { const p = document.createElement(\'div\'); p.textContent = \'🎉\'; p.style.position = \'absolute\'; p.style.left = Math.random()*100 + \'%\'; p.style.top = \'-20px\'; p.style.fontSize = \'20px\'; p.style.transition = \'transform 1.2s ease-in, opacity 1.2s\'; container.appendChild(p); requestAnimationFrame(() => { p.style.transform = \'translateY(300px)\'; p.style.opacity = \'0\'; }); setTimeout(() => p.remove(), 1300); }"',
        );
      }
      if (active.has("ambientEffect")) {
        lines.push(
          '   - `onLoad` is DIFFERENT: it runs ONCE, immediately, when the change is applied (not tied to any message/reaction event) — use this for anything AMBIENT, CONTINUOUS, or PERSISTENT ("slithers around the screen", "floats around continuously", "always drifting", anything with no natural end). The code should create its element(s) once and set up an INFINITE CSS animation (`animation-iteration-count: infinite`, or omit the count in a shorthand that already implies it, e.g. reference an `@keyframes` in `customCSSText` with `animation: name 8s linear infinite`) so it keeps running on its own — do NOT setTimeout-remove it, and do NOT try to make an infinite effect out of onMessageReceived/onMessageSent/onReaction, since those only fire when that specific event happens, not continuously.',
          '   - Example onLoad value for "a small snake that continuously slithers across the screen" (paired with `customCSSText` defining `@keyframes slither {...}`): "const snake = document.createElement(\'div\'); snake.textContent = \'🐍\'; snake.style.position = \'absolute\'; snake.style.fontSize = \'24px\'; snake.style.animation = \'slither 8s linear infinite\'; container.appendChild(snake);"',
        );
      }
      if (active.has("ambientEffect") && active.has("reactiveEffect")) {
        lines.push(
          '   - Getting this distinction right matters: a request for continuous/ambient motion mapped onto a message-triggered event will falsely report success while only ever appearing right after that event fires, which reads as "nothing happened" the rest of the time — always prefer onLoad for anything described as ongoing, moving on its own, or without a clear one-time trigger.',
        );
      }
      return lines;
    },
  },
  {
    at: "hatches",
    needs: ["interactiveComponent"],
    build: () => [
      '`customComponents` — a whole new INTERACTIVE widget, for requests the other hatches can\'t reach because they need real state/behavior, not just style or a one-shot effect: a countdown timer, a small calculator, a mini game, anything with its own ongoing UI. An array of up to 5 objects: {"id": <short stable slug, e.g. "countdown-timer">, "label": <short human name shown if it errors, e.g. "Countdown Timer">, "slot": "composerActions"|"headerActions"|"standalone", "code": <string, see contract below>}.',
      "   - CODE CONTRACT (strict — anything else fails to compile): the string must define EXACTLY one top-level `function Component(props) { ... }` using JSX to return its UI, and nothing else — no import/export statements, no code outside that one function. React and the hooks useState/useEffect/useRef are already in scope — call them directly (`useState(0)`, not `React.useState(0)`).",
      '   - `props` gives you: `messages` (the current message list, read-only — each item is `{id, authorId, text, time, isMine, reactions?, editedAt?}`; `time` is an ISO timestamp string, `authorId` (NOT `senderId`) identifies the sender, `isMine` is true for the viewer\'s own messages — use these exact field names, do not guess plausible-sounding ones), `viewerId` (string, matches a message\'s `authorId` when it is the viewer\'s own), `sendMessage(text)` (a function — call it to send a real message into the chat, e.g. for a timer that announces when it hits zero), plus `sharedState`/`setSharedState` (see SCOPE below).',
      '   - SCOPE — every component needs a `"scope"` field, `"personal"` or `"shared"`:',
      '     * `"personal"` (the default) renders only for the person who asked for it, and its state is private to them. Correct for anything one-sided: a calculator, a countdown timer, a unit converter, a personal note pad.',
      '     * `"shared"` renders for BOTH people in the conversation and is kept in sync live. Correct — and REQUIRED — for anything the two people do together: a two-player game, a shared to-do list, a live poll with real votes, a collaborative drawing surface, a shared counter or scoreboard. A game marked "personal" is broken by construction: the other person cannot see the board at all, so there is nobody to play against.',
      '   - Pick `slot` by size: "composerActions" or "headerActions" for something small and pill-shaped (a button, a live number); "standalone" for something that needs more room (a small canvas, a multi-button calculator) — it gets its own full-width strip.',
      "   - Keep it robust: clean up every `setInterval`/`setTimeout` in a `useEffect` cleanup function so it doesn't run forever after the user moves on; avoid unbounded loops.",
      "   - KEEP IT COMPACT — `code` is hard-capped at 6000 characters and a component over that is rejected outright, so the user gets nothing. Aim well under it (most good widgets are 1500-4000). If the idea won't fit, ship the simpler version of the feature rather than a longer one: drop the extra options, the styling flourishes, the edge-case handling. A working small widget beats an ambitious rejected one.",
      '   - SIZE IS ENFORCED, not just a suggestion: "standalone" renders in a strip capped at 240px tall (scrolls internally past that) — never use `position: fixed` or a large explicit width/height inside your JSX, since that can visually cover the chat instead of sitting inside your allotted space. For a grid-based widget (tic-tac-toe, a small game board), keep each cell small (e.g. 32-40px) so the whole board comfortably fits well under the height cap — do not assume you have the whole screen.',
      '   - To ADD one: include it in `customComponents` alongside any existing ones that should stay (you are given the current spec, including any that already exist — echo them back unchanged unless the instruction is about them specifically). To MODIFY one: keep its `id`, change what needs to change. To REMOVE one: simply leave it out of the array — but note the user ALSO has a direct "✕" button on every component that removes it instantly without needing you, so don\'t worry about being asked to remove something that may already be gone.',
      '   - Example minimal `code` value for "add a 60 second countdown timer": "function Component({ sendMessage }) {\\n  const [seconds, setSeconds] = useState(60);\\n  useEffect(() => {\\n    if (seconds <= 0) { sendMessage(\'Time\\\'s up!\'); return; }\\n    const id = setTimeout(() => setSeconds(s => s - 1), 1000);\\n    return () => clearTimeout(id);\\n  }, [seconds]);\\n  return <span>⏱ {seconds}s</span>;\\n}"',
    ],
  },
  {
    at: "hatches",
    needs: ["sharedState"],
    build: () => [
      'SHARED STATE (for the `scope: "shared"` component above) — `useState` is per-person and per-tab, so a board kept in `useState` shows one player their own moves and never the other\'s. Use the `sharedState`/`setSharedState` props instead; they are the same value for both people and update live in each other\'s browser.',
      "   - `props.sharedState` is whatever was last written (any JSON value: object, array, number, string). It is `null` until the first write, so ALWAYS handle that: `const board = props.sharedState ?? { squares: Array(9).fill(null), turn: 'X' };`",
      "   - `props.setSharedState(next)` writes it for both people. It accepts a value or an updater function exactly like `useState`'s setter — prefer the updater form (`setSharedState(prev => ({ ...prev, squares }))`) so a move isn't computed from a stale copy while the other person is also playing.",
      "   - Store the WHOLE shared value each time — this replaces, it does not merge.",
      '   - A POLL or a VOTE is always one of these. "Add a poll" means a real shared component both people can vote in, with the options and the running counts stored in sharedState — not a static picture of a poll that tallies nothing.',
      "   - Use `props.viewerId` to tell the two people apart (whose turn it is, who added a to-do item, which colour a stroke is). Assign identities by writing them into the shared state on first use rather than assuming who moves first.",
      "   - Do NOT mirror shared state into `useState` and write back on every render — that's a feedback loop between the two browsers. Read from `props.sharedState` directly and write only in response to a real user action (a click, a submit).",
      "   - `setSharedState` REPLACES the whole value, so two people writing at the same instant resolve last-write-wins. That's fine for turn-taking (a game where only one person moves at a time) but it silently loses data when both write at once.",
      "   - `props.appendSharedState(listKey, item)` is the fix for that case: it appends `item` to the array at `sharedState[listKey]` atomically on the server, so simultaneous appends from both people BOTH survive. Use it for anything that accumulates — drawing strokes on a shared canvas, items added to a list, entries in a log, guesses in a game.",
      "   - Rule of thumb: if two people could reasonably act at the SAME moment, append. If the thing is inherently turn-based or single-valued (whose turn it is, the current question), replace with setSharedState.",
      '   - Example for a shared counter: "function Component({ sharedState, setSharedState }) {\\n  const count = sharedState?.count ?? 0;\\n  return <button onClick={() => setSharedState(prev => ({ count: (prev?.count ?? 0) + 1 }))}>Tapped {count} times</button>;\\n}"',
      '   - WHITEBOARD/DRAWING SPECIFICALLY (this genre has repeatedly come out broken — follow this exactly): one `appendSharedState(\'strokes\', item)` call PER STROKE, never per point. A stroke is everything from pointer-down to pointer-up. Collect its points in a LOCAL ref/state array while the pointer moves, and only call `appendSharedState` ONCE, on pointer-up, with the complete stroke: `{ points: [[x,y], [x,y], ...], color, width, by: viewerId }`. Appending on every `pointermove` is the single most common bug here — it does not just spam the network, it makes strokes look "jumpy" and lines "self-connect": each render then either draws one path per (near-empty, single-point) list entry, or — if you instead flatten all points into one path — draws a straight connecting line from the LAST point of one stroke to the FIRST point of the next, because nothing marks where one stroke ends and the next begins.',
      "   - Rendering: each entry in `sharedState.strokes` is exactly one stroke — render each as its OWN `<polyline>` (SVG, not `<canvas>`; far simpler to get right and to keep strokes visually separate) with `points={item.points.map(p => p.join(\",\")).join(\" \")}`, `stroke={item.color}`, `fill=\"none\"`, `strokeWidth={item.width}`, `strokeLinecap=\"round\"`, `strokeLinejoin=\"round\"`. Never draw a single path through points from more than one stroke.",
      "   - Coordinates: compute points relative to the drawing surface's own bounding box (`e.clientX - rect.left`, using a ref's `getBoundingClientRect()`), never raw `clientX`/`clientY` — using page coordinates directly is what makes strokes drift/jump depending on where the widget sits on the page.",
      "   - Color: keep the ACTIVE color in local `useState` (`const [color, setColor] = useState('#000000')`), set by onClick on real swatch buttons/elements (a color `<input type=\"color\">` also works) — a swatch that doesn't call `setColor` is a color picker that visibly does nothing, which is the other bug this genre keeps shipping with. Read `color` when a stroke ENDS and include it in the appended stroke object, not some hardcoded constant.",
      '   - Cursor: an SVG drawing surface with the plain default/crosshair cursor reads as broken, not "ready to draw". Use a small circle outline sized to the brush instead: `style={{ cursor: `url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'%3E%3Ccircle cx=\'10\' cy=\'10\' r=\'8\' fill=\'none\' stroke=\'black\' stroke-width=\'2\'/%3E%3C/svg%3E") 10 10, crosshair` }}` — copy this pattern exactly (it is plain ASCII, safe to embed in a template literal; do not substitute an emoji-based cursor, which needs multi-byte percent-encoding and is easy to get subtly wrong).',
      '   - Bound the canvas size to the standalone slot\'s height cap (see SIZE IS ENFORCED above) — e.g. a fixed `width={320} height={200}` SVG, not something that grows with content.',
    ],
  },
  {
    at: "tail",
    needs: ["imageGeneration"],
    build: () => [
      "",
      'IMAGE GENERATION: this request describes visual content that needs real generated artwork — an animal, a character, a specific object or place, a style ("cartoon", "watercolor", "pixel art"), something the 8 fixed scenes don\'t cover. Set `backgroundImagePrompt` to a good, specific, safe image-generation prompt (style + subject, e.g. "a cute cartoon dog, flat illustration style, colorful, simple background, no text"). A few seconds after your response, the system will actually generate that image and switch the background to it on its own — you never set `wallpaper` to "generated" or touch `wallpaperUrl` yourself, ever. Instead, set `theme.wallpaper` to a normal value (the closest of the 8 fixed scenes, or a gradient) exactly as you would for any other request — that\'s what\'s shown while generating, and what stays shown if generation fails, so make it a genuine best-effort, not a placeholder. When backgroundImagePrompt is set, leave `limitation` null — the system handles explaining a generation failure itself if one occurs.',
    ],
  },
];

/** The hatch names available under a given genre set, for the "prefer the
 *  simplest one" guidance — which would otherwise name mechanisms whose
 *  instructions weren't included in this prompt. */
export function hatchNamesFor(active: Set<Genre>): string[] {
  const names: string[] = [];
  if (active.has("customCSS")) names.push("customCSS");
  if (active.has("animation")) names.push("customCSSText");
  if (active.has("ambientEffect") || active.has("reactiveEffect")) names.push("customEffects");
  if (active.has("interactiveComponent")) names.push("customComponents");
  return names;
}

/** The `customComponents` entry shape shown in the spec skeleton, which grew a
 *  `scope` field once components could be conversation-scoped. */
export const CUSTOM_COMPONENT_SHAPE =
  '{"id":...,"label":...,"slot":...,"code":...,"scope":"personal"|"shared"}';
