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
      'something should happen ONCE, in response to a specific event — sending a message, receiving one, or reacting. "confetti when I get a message", "flash the screen on a reaction".',
    routerHint: 'one-shot effects on an event — "pop confetti when I receive a message", "flash on a reaction"',
  },
  interactiveComponent: {
    classifierHint:
      'the request needs a real WIDGET with its own state and behavior, not just styling or a one-shot effect — a timer, a counter, a calculator, a mini-game (tic-tac-toe, trivia), a to-do list, a scoreboard, any ongoing UI the user can interact with. Also use this flag for removing or modifying a widget that already exists.',
    routerHint:
      'real interactive widgets with their own state — timers, counters, calculators, mini-games (including tic-tac-toe), to-do lists, scoreboards, and removing/modifying ones already added',
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
      '   - `props` gives you: `messages` (the current message list, read-only), `viewerId` (string), `sendMessage(text)` (a function — call it to send a real message into the chat, e.g. for a timer that announces when it hits zero).',
      '   - Pick `slot` by size: "composerActions" or "headerActions" for something small and pill-shaped (a button, a live number); "standalone" for something that needs more room (a small canvas, a multi-button calculator) — it gets its own full-width strip.',
      "   - Keep it robust: clean up every `setInterval`/`setTimeout` in a `useEffect` cleanup function so it doesn't run forever after the user moves on; avoid unbounded loops.",
      '   - SIZE IS ENFORCED, not just a suggestion: "standalone" renders in a strip capped at 240px tall (scrolls internally past that) — never use `position: fixed` or a large explicit width/height inside your JSX, since that can visually cover the chat instead of sitting inside your allotted space. For a grid-based widget (tic-tac-toe, a small game board), keep each cell small (e.g. 32-40px) so the whole board comfortably fits well under the height cap — do not assume you have the whole screen.',
      '   - To ADD one: include it in `customComponents` alongside any existing ones that should stay (you are given the current spec, including any that already exist — echo them back unchanged unless the instruction is about them specifically). To MODIFY one: keep its `id`, change what needs to change. To REMOVE one: simply leave it out of the array — but note the user ALSO has a direct "✕" button on every component that removes it instantly without needing you, so don\'t worry about being asked to remove something that may already be gone.',
      '   - Example minimal `code` value for "add a 60 second countdown timer": "function Component({ sendMessage }) {\\n  const [seconds, setSeconds] = useState(60);\\n  useEffect(() => {\\n    if (seconds <= 0) { sendMessage(\'Time\\\'s up!\'); return; }\\n    const id = setTimeout(() => setSeconds(s => s - 1), 1000);\\n    return () => clearTimeout(id);\\n  }, [seconds]);\\n  return <span>⏱ {seconds}s</span>;\\n}"',
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
