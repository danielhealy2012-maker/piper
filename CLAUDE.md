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
2. **Action plan** (`actions.ts` → `PlanSchema`/`validatePlan` → pure appliers → message state).
   Controls conversation content. Same principle: the router picks typed actions, `validatePlan`
   gates them, and the pure appliers (`applyEdit`/`applyDelete`/`applyReaction`) are the only
   code that mutates messages. A hallucinated message id is re-checked at execution
   (`messageExists`) and skipped, never applied.

The intelligence is in *routing and parameter-filling*, not code generation — which is why
"submit any prompt and it figures it out" stays safe and testable.

## The router (`src/engine/route.ts`, `src/engine/actions.ts`, proxy `/api/route`)

`Workspace.tsx`'s `runInstruction` orchestrates:

1. **Free keyword fast-path** (`keywordOnly` in `generate.ts`) — pure theme edits handled by
   the deterministic stub, instant, no network.
2. **Router** — `routeInstruction` POSTs the instruction + a description of the live
   conversation to `/api/route`. The model returns a `Plan`:
   `{ messageActions[], themeInstruction, reply, feasible }`.
   - `messageActions`: `translateMessage` (free-text `targetLanguage`), `editMessage`,
     `deleteMessage`, `reactToMessage`. The model resolves references ("Sam's last message")
     to concrete ids itself.
   - `themeInstruction`: the appearance part of the request, delegated **verbatim to the
     existing `generateSpec`** so we reuse all its validated 24-token color/gradient/scene
     logic instead of re-teaching the router. null when there's no appearance part.
   - `reply` + `feasible`: when nothing maps, `feasible:false` and `reply` explains why and
     suggests the closest capability — this is the "assess feasibility, tell the user" path,
     surfaced as the prominent amber notice.
3. Each applied instruction pushes an **inverse operation** onto the undo stack (see the
   deployment section above — snapshots are wrong here). Destructive actions apply
   immediately and are reversible rather than gated behind a confirm.

Adding a new capability = one entry in `MessageActionSchema` + one pure applier + one line in
`buildRouterPrompt`. That's the extension model — grow the catalog, never generate code.

Message content is NOT persisted (only theme specs are); it resets on reload and is shared
across the You/Sam viewer toggle.

## Registry surface (`src/engine/registry.ts`)

- **24 theme tokens**: chatTitle, bubbleColorOutgoing/Incoming, textColorOutgoing/Incoming,
  accentColor, bubbleScale, cornerStyle, sendButtonStyle, fontFamily, density, showAvatars,
  showTimestamps, bubbleTail, sentimentTint, plus the background stack below.
- **Backgrounds are layered.** `wallpaper` picks the BASE, and each base reads its own tokens:
  `custom` -> `wallpaperColor` (any hex); `gradient` -> `gradientFrom`/`gradientVia`/`gradientTo`
  at `gradientAngle`; `image` -> `wallpaperImage` (a bundled scene); plus the legacy fixed
  presets `none`/`dots`/`grid`/`sunset`/`ocean`/`charcoal`. `wallpaperPattern` +
  `patternOpacity` are an INDEPENDENT overlay composited on top of whichever base is chosen,
  which is what makes "blue background with stripes" expressible.
- **Bundled scenes** live in `public/wallpapers/*.svg` — hand-authored illustrated SVGs
  (mountains, waves, city, forest, desert, aurora, confetti, bokeh), NOT photographs. There is
  no image search or image generation: if a user asks for a photo, the only options are the
  closest bundled scene or a gradient. `theme.ts`'s `DARK_SCENES` marks which ones need light
  chrome; `isDarkWallpaper()` also luminance-averages gradient stops and custom colors.
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

## Generation routing ladder (`src/engine/generate.ts`)

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
2. **Model** (`callModel`) — POSTs to `/api/generate` with a system prompt built from the
   registry itself (`buildSystemPrompt()`, one source of truth). Default model: `claude-haiku-4-5`.
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
