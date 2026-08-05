# Piper

An iMessage-style chat you reshape by talking to it. You can restyle the whole UI
("make my bubbles green with tails", "sunset gradient background") AND operate on the
conversation itself ("translate Sam's last message to Japanese", "replace my first message
with X", "delete the last message", "react with 🔥"). Any prompt is routed to a validated
action, or to a plain explanation of why it can't be done + the nearest thing that can.

## Deployment shape (multiplayer)

The app has two runtime modes, chosen at startup by whether `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` are set (`src/lib/supabase.ts` → `isSupabaseConfigured`):

- **Demo mode** — `createLocalBackend()`, two fake users, in-memory messages. Keeps
  local dev working with zero credentials.
- **Multiplayer** — `createSupabaseBackend()`, real accounts (magic link), real-time
  messages, per-user themes.

Both satisfy the same `ChatBackend` interface (`src/lib/backend.ts`), so `Workspace.tsx`
(the UI + instruction orchestrator) is backend-agnostic. `App.tsx` only does auth,
invite-code handling, and picking the backend.

**Scope model — the heart of the product.** Enforced twice: in the client and, more
importantly, by Postgres RLS in `supabase/migrations/0001_init.sql`.
- *Personal* (`member_theme`, `personal_overlays`): owner-only for read AND write. This
  is what makes "my appearance changes only show up for me" actually true.
- *Shared* (`messages`, `reactions`, `polls`, `poll_votes`): any conversation member.
- *Own-content-only*: message edit/delete require `author_id = auth.uid()`. The
  orchestrator also checks `message.isMine` first so the user gets a real explanation
  instead of a 403.

**Undo is inverse-operations, not snapshots** (`Workspace.tsx`). With a shared realtime
conversation, restoring a whole state snapshot would clobber messages the other person
sent in the meantime. Each action pushes its own inverse (edit → restore prior text,
delete → clear `deleted_at`, react → toggle again, theme → re-save previous spec).

**API endpoints exist twice on purpose**: `server/proxy.mjs` for local dev, and
`api/*.js` (Vercel serverless) for production. Same relative `/api/*` paths, so no
environment-specific URLs in the client. The deployed ones additionally verify the
Supabase JWT and meter per-user daily usage (`api/_lib.js`) — they are public URLs and
must not become a free proxy to the Anthropic key. `src/lib/api.ts` attaches the token.

## Two engines, one safety thesis

Everything the model produces is a **choice from a bounded catalog**, validated by zod before
it touches anything. The model never authors code — no `eval`, no `dangerouslySetInnerHTML`,
no dynamic import. There are two catalogs:

1. **Theme spec** (`registry.ts` → `spec.ts` `validateSpec` → `slots.tsx` `renderAction` → DOM).
   Controls appearance. `validateSpec` is the only path to the themed DOM and runs on stub
   output, model output, AND localStorage-rehydrated specs (`persist.ts` distrusts old specs).
   Three escape hatches for anything the fixed 20-odd tokens can't express: `customCSS`
   (free-form CSS properties per zone — bubbleOutgoing/bubbleIncoming/background/header),
   `customEffects` (JS source compiled with `new Function` and run against a container node on
   message/reaction events), and `customComponents` (a whole model-authored React component —
   real interactive widgets like a countdown timer or calculator, not just style/one-shot
   behavior). See `engine/legibility.ts`'s `enforceLegibility()` — a post-processing pass that
   corrects low-contrast text and un-padded shape clips the model generates, since prompting
   alone doesn't reliably prevent those.
   - **`customComponents`** (`components/customComponentRuntime.ts` + `CustomComponentSlot.tsx`):
     each entry is `{id, label, slot, code}`. `code` must be exactly one
     `function Component(props) {...}` using JSX — no import/export. Compiled at runtime with
     `@babel/standalone` (lazy-loaded via dynamic `import()`, so it never touches the base bundle
     for anyone who doesn't use this) into a real component via `new Function`, given `React` +
     `useState`/`useEffect`/`useRef` as call arguments (not lexical imports) so hook rules still
     hold when React itself renders it. `props` exposes `messages`, `viewerId`,
     `sendMessage(text)`. Mounts in one of three zones: `composerActions`/`headerActions` (small,
     pill-shaped) or `standalone` (its own full-width strip, for something bigger). Wrapped in a
     per-component React error boundary so a render-time crash kills only that widget. Every
     instance ALWAYS shows a "✕" that removes it via `Workspace.tsx`'s `removeCustomComponent()`
     — a direct, model-independent way out, since unlike a one-shot `customEffect`, a bad
     component can misbehave for as long as it stays mounted (leaked interval, bad render loop)
     and there's no realistic way to sandbox against that without a Worker + hard kill, which
     isn't implemented. This is the same "worst case breaks the app, not the machine" trust
     posture as the other two hatches, explicitly confirmed by the user as extending to full
     component code, not just styling/one-shot effects.
2. **Action plan** (`actions.ts` → `PlanSchema`/`validatePlan` → `Workspace.tsx`'s
   `runInstruction`). Controls conversation content. The router picks typed actions,
   `validatePlan` gates them, and `runInstruction` executes each by calling the current
   `ChatBackend` (`edit`/`remove`/`react`/`removeAllBy`/etc. in `lib/backend.ts`) — there is no
   separate "pure applier" layer; the backend call *is* the mutation, and for the Supabase
   backend, Postgres RLS is the actual enforcement point, not client code. A hallucinated
   message id is re-checked against the live message list before any backend call and skipped
   if absent.

The intelligence is in *routing and parameter-filling*, not code generation — which is why
"submit any prompt and it figures it out" stays safe and testable.

## The router (`src/engine/route.ts`, `src/engine/actions.ts`, proxy `/api/route`)

`Workspace.tsx`'s `runInstruction` orchestrates:

1. **Free keyword fast-path** (`keywordOnly` in `generate.ts`) — pure theme edits handled by
   the deterministic stub, instant, no network.
2. **Router** — `routeInstruction` POSTs the instruction + a description of the live
   conversation (messages AND a participants list with real `authorId` values — actions like
   `deleteAllMessagesBy` need a real id, not just a display name) to `/api/route`. The model
   returns a `Plan`: `{ messageActions[], themeInstruction, themeMutation, conversationTitle,
   clearConversation, reply, feasible, needsClarification }`.
   - `messageActions`: `translateMessage`, `editMessage`, `deleteMessage`,
     `deleteAllMessagesBy`, `reactToMessage`, `deleteReaction`, `deleteAllReactions`,
     `pinMessage`/`unpinMessage`, `starMessage`/`unstarMessage`, `summarizeConversation`,
     `generateResponse`, `suggestReplies`. The model resolves references ("Sam's last message")
     to concrete ids itself. Reaction deletes are real deletes, never a toggle that could add
     one back — RLS only allows deleting your own reaction row, so `deleteReaction` reports "no
     such reaction" rather than silently reacting when the target isn't the viewer's own.
   - `themeInstruction`: the appearance part of the request (including animations/one-shot
     effects — these are appearance, not a separate capability), delegated **verbatim to the
     existing `generateSpec`**. `themeMutation` (`"reset"|"randomize"`) is for explicit theme
     resets rather than a described change. null/null when there's no appearance part.
   - `conversationTitle` / `clearConversation`: rename or wipe the conversation.
   - `needsClarification`: true ONLY for genuine ambiguity (multiple plausible readings), never
     for merely-underspecified-but-obvious requests — the router should act, not ask, whenever
     it can make a confident call. When true, `Workspace.tsx` shows the question in a distinct
     blue box and treats the next instruction as the answer, merging it with the original ask.
   - `reply` + `feasible`: when nothing maps, `feasible:false` and `reply` explains why and
     suggests the closest capability — this is the "assess feasibility, tell the user" path,
     surfaced as the prominent amber notice.
3. Each applied instruction pushes an **inverse operation** onto the undo stack (see the
   deployment section above — snapshots are wrong here). Destructive actions apply
   immediately and are reversible rather than gated behind a confirm.

Adding a new MESSAGE capability = one entry in `MessageActionSchema` + one case in
`runInstruction`'s action switch (backed by a real `ChatBackend` method if it's a new kind of
mutation). That's the extension model — grow the catalog, never generate code for
conversation actions. Adding a new APPEARANCE capability = one entry in `genres.ts`; the
router's list of what `themeInstruction` can cover is generated from that catalog rather than
hand-maintained here, which is what stops it drifting behind the engine again. (Appearance is the one place actual code-shaped output — CSS/JS strings —
is allowed through, via the two spec escape hatches above, precisely because it renders/executes
in a way that can't reach outside the chat UI itself.)

Known gaps as of the last pass: `filterByAuthor` is defined in the schema but not wired to any
UI state — the router no longer offers it, and if you re-add it to the prompt, build the actual
filtering first. Pin/star state is in-memory per session (`Workspace.tsx`), not persisted —
refresh clears it.

Message content is NOT persisted (only theme specs are); it resets on reload and is shared
across the You/Sam viewer toggle.

## Registry surface (`src/engine/registry.ts`)

- **24 theme tokens**: chatTitle, bubbleColorOutgoing/Incoming, textColorOutgoing/Incoming,
  accentColor, bubbleScale, cornerStyle, sendButtonStyle, fontFamily, density, showAvatars,
  showTimestamps, bubbleTail, sentimentTint, plus the background stack below.
- **Backgrounds are layered.** `wallpaper` picks the BASE, and each base reads its own tokens:
  `custom` -> `wallpaperColor` (any hex); `gradient` -> `gradientFrom`/`gradientVia`/`gradientTo`
  at `gradientAngle`; `image` -> `wallpaperImage` (a bundled scene); `generated` ->
  `wallpaperUrl` (a real AI-generated image, see below); plus the legacy fixed presets
  `none`/`dots`/`grid`/`sunset`/`ocean`/`charcoal`. `wallpaperPattern` + `patternOpacity` are an
  INDEPENDENT overlay composited on top of whichever base is chosen, which is what makes "blue
  background with stripes" expressible.
- **Bundled scenes** live in `public/wallpapers/*.svg` — hand-authored illustrated SVGs
  (mountains, waves, city, forest, desert, aurora, confetti, bokeh), NOT photographs. `theme.ts`'s
  `DARK_SCENES` marks which ones need light chrome; `isDarkWallpaper()` also luminance-averages
  gradient stops and custom colors.
- **Real image generation** (`wallpaper: "generated"`) fills the gap the 8 fixed scenes can't:
  `generate.ts`'s theming model sets `backgroundImagePrompt` (a text prompt it authors — it never
  sees or sets `wallpaperUrl` itself) plus a normal fallback wallpaper in case generation fails.
  `generateSpec()`'s `resolveBackgroundImage()` then calls `lib/image.ts` -> `api/image.js`
  (Replicate/Flux-schnell), which hashes the prompt, checks the `generated_backgrounds` cache
  table first (repeat prompts cost nothing), and otherwise generates, re-hosts the image in the
  Supabase Storage `backgrounds` bucket (migration `0002_image_storage.sql`) for a stable URL,
  and caches the row. `spec.ts`'s `wallpaperUrl` validator is the actual trust boundary: it only
  accepts an https URL under this project's own Storage host, which is what makes "the model
  can only author a prompt, never a URL" true even against a tampered/rehydrated spec. Metered
  under the existing `image` usage kind (`api/_lib.js`'s `DAILY_LIMITS`). Not available in local
  dev (`server/proxy.mjs` returns a clean 503 for `/api/image`; the theme model's own fallback
  wallpaper is what's shown instead).
- **3 slots**: `messageActions` (TranslateButton, SummarizeButton, CopyButton, PinButton,
  ReactionBar, ReadReceipt), `composerActions` (ToneShifter, ClearButton,
  VoiceNote, GifPicker, Poll, ScheduledSend, AIReplyDraft), `headerActions` (SearchBox,
  MuteToggle, ThemeBadge, VideoCallButton).
- A handful of components carry real prop schemas (TranslateButton, ReactionBar, Poll,
  ToneShifter, ThemeBadge) — everything else takes no props. This is deliberate: the point is
  proving prop validation works on genuine prop-bearing components, not model-friendly divs.
- `TranslateButton` is the one component that makes a network call (see below). Real AI-backed
  suggested replies live in the router's `suggestReplies`/`generateResponse` actions (see
  Query & Analysis), not as a composer component. Summarize, ToneShifter and the legacy
  AIReplyDraft composer button are still canned/local demos by choice.

## Messages are backend-driven

`src/data/seed.ts`'s `SEED_MESSAGES` only seeds the demo backend. `Workspace.tsx` holds
`messages` in state but never owns them: it calls `backend.fetchMessages()` and re-fetches
whenever `backend.subscribe()` fires (Supabase Realtime in multiplayer, an in-memory
listener in demo mode). Sending/editing/deleting/reacting all go through the backend, so
the same UI code drives both modes. `Chat.tsx` renders `ChatMessage[]` generically, so
spec-driven styling applies to newly-arrived messages automatically. Keep the
auto-scroll-to-bottom effect — without it a new message is appended but invisible.

Message content is NOT persisted in demo mode (resets on reload); in multiplayer it lives
in Postgres. Theme specs persist per user in both modes.

## The genre catalog (`src/engine/genres.ts`) — one source of truth for capabilities

`GENRES` names every KIND of thing a `themeInstruction` can produce (`customCSS`,
`animation`, `ambientEffect`, `reactiveEffect`, `interactiveComponent`, `imageGeneration`).
Three prompts used to each carry their own hand-written copy of this knowledge and drifted
apart every time a capability shipped: the router (which rejects what it doesn't believe
exists — the bug that made "insert a timer" and "add a tic-tac-toe game" come back as
"Piper can't do that"), and the two theme-generation stages below. All three now read this
file, so **adding a capability is one entry here**, and `npm run check` fails if a genre
ever stops being represented in the classifier or router prompt.

Each genre carries a `classifierHint` (when the flag applies), a `routerHint` (proof to the
router that the capability exists), and — via `SPECIALIST_SECTIONS` — the actual mechanism
instructions, which are only included in a request that needs them. `IMPLIES` expands
dependencies: an `@keyframes` block is useless without a `customCSS` `animation` property
to reference it, so `animation` pulls in `customCSS`, and `ambientEffect` pulls in both.

## Generation routing ladder (`src/engine/generate.ts`)

Rung 2 is **two model calls, not one** (classify, then generate):

- **Stage 1 — classifier** (`engine/classify.ts` → `/api/classify`): a small, cheap call
  that sees ONLY the instruction (no spec — this is about intent, not state) and returns
  the genre flags it needs. Zero flags means a plain token-only change.
- **Stage 2 — specialist** (`buildSystemPrompt(genres)`): assembles the base token/slot/
  legibility instructions plus ONLY the mechanism blocks those flags call for. In practice
  a narrowed prompt is 51–70% the size of the old every-mechanism one.

Why: one model call holding every mechanism's instructions simultaneously was the common
root cause behind three separate bugs (the wrong escape hatch chosen, output truncating
mid-JSON, the router rejecting capabilities it had lost track of). Splitting intent from
execution is what makes new capabilities addable without making every request's prompt worse.

Three things keep a misclassification from becoming a lost capability:
1. `classifyInstruction()` returns **null** when the call fails or won't parse, and null
   means `buildSystemPrompt` builds the old full mega-prompt. This is an accuracy
   improvement, never a new point of failure.
2. `genresPresentInSpec(current)` is unioned in, because the specialist must echo the whole
   spec back and can only do that faithfully for mechanisms it was given the contract for.
   Without it, "make the background blue" against a spec holding a tic-tac-toe game would
   classify as token-only and the model would most likely drop the game.
3. The **escalation retry deliberately passes `null`** — the full prompt. A no-op result is
   exactly the symptom a misclassification produces, so retrying with the same narrow
   prompt would fail identically.

1. **Keyword stub** (`draft()`) — free, deterministic, pattern-matches the instruction. Used
   directly ONLY when it validates, made ≥1 change, `residualContentWords()` is empty (no
   leftover words the stub didn't recognize), AND the result isn't flagged `ambiguous`. The
   remainder gate stops a compound instruction like "green bubbles and confetti when I send"
   from silently applying only the recognized half; the ambiguity flag stops it from GUESSING
   when two different colors aim at the same target ("make it blue and green"). Both hand off
   to the model instead.
   - Colors are bound **clause by clause** (`bindColors()`): the instruction is split on
     `,`/`and`/`with`, and each color attaches to the nearest target noun in its own clause
     (background/backdrop/wallpaper, bubbles/messages, text/letters/words, accent). This is
     what makes "white background with blue bubbles" set two different things correctly.
     The old code scanned COLOR_MAP's key order instead of sentence order, so it returned
     whichever color happened to sit earliest in the map — do not reintroduce that.
   - The `VOCAB` set backing the remainder gate must stay in sync with every word `draft()`
     actually consumes — a trigger word missing from `VOCAB` means a fully-understood
     instruction still gets escalated to the model for no reason (has happened twice:
     "scheduled" vs "schedule", and "text").
2. **Model** (`callModel`) — classify (above), then POST to `/api/generate` with a system
   prompt built from the registry itself plus the classified genres' mechanism blocks
   (`buildSystemPrompt(genres)`, one source of truth). Default model: `claude-haiku-4-5`.
3. **No-op / escalation** — a model response is only treated as success if the returned spec is
   validated AND structurally different from the input (`specsEqual()` in `spec.ts`, which
   canonicalizes key order before comparing — needed because action `props` are a free-form
   `z.record` that zod doesn't reorder like the rest of the spec). If the model returns an
   invalid spec OR a no-op (byte-identical spec — i.e. it silently failed to find a
   representable change), retry once with `claude-opus-4-8` (`ESCALATION_MODEL`). If that
   also fails, the spec is left unchanged and the UI shows a clear, prominent, dismissible
   notice — not just a change-log line — via `App.tsx`'s `notice` state.

If the proxy is offline or has no key, the app falls back to whatever the keyword stub managed
(or a helpful "try..." message) — Piper fully works with no API key (translation excepted —
see below).

These model IDs are current, real Anthropic model IDs — do not "correct" them to older names.

## Real translation (`server/proxy.mjs` `/api/translate`, `src/engine/translate.ts`)

Two entry points, one endpoint: the `TranslateButton` component (auto target) and the
`translateMessage` router action (any `targetLanguage`). Translation state lives in **App**
(`translations` map), passed down to Chat read-only, because it replaces the BUBBLE text and
both the button and the router action need to drive it. Chat renders `translated ?? message.text`
in the bubble, plus an "Original" label with the source text in small grey italics/quotes
underneath. Pressing the button again restores the original.

`target` is **free text** — a language name ("French", "Japanese") or the sentinel `"auto"`
(non-English→English, English→Spanish). The endpoint returns
`{ sameLanguage, translation }`: `sameLanguage:true` means the text was already in the
requested language, so the caller shows "already in X" instead of a no-op. This is the
"translate to English but it's already English → tell the user" case.

**The prompt is deliberately defensive and must stay that way.** The text being translated is
itself a chat message, so it almost always looks like something addressed to the assistant
("hey want to grab dinner?"). Passing it as a bare user turn made the model *answer* it
instead of translating it. Mechanisms that prevent it, none removable: the text is fenced in
`<text>` tags and declared to be data, the task is restated where message content can't
out-argue it, the response is forced to a JSON object (which also carries `sameLanguage`),
and the assistant turn is **prefilled with `{`** so the only continuation is that JSON.
