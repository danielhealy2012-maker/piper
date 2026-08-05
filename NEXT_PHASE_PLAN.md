# Piper — Next Phase Build Plan

**Status:** Approved by Dan, not yet started. Written as a handoff document for a fresh
session (model upgrade to Opus 5) — read this in full before writing any code.

**How to use this doc:** Work top to bottom. Phase 0 and Phase 1 are foundational —
almost everything in Phase 2 depends on them, so build them first even though Dan's
approval list (Phase 2) was the more exciting part of the conversation that produced this
plan. Check in with Dan before starting Phase 2 items that are large on their own
(two-player games, shared whiteboard) even though they're pre-approved — confirm the
Phase 1 primitive they depend on actually feels right in practice first.

Read `CLAUDE.md` and `FUNCTIONALITY.md` before starting — they document the current
architecture and capability matrix this plan builds on. Keep both updated as you go,
per existing project convention.

---

## Phase 0 — Router redesign (do this first, or very early)

**Confirmed direction, not yet built.** Every phase below adds MORE genres of things
`themeInstruction` can produce (shared state, scheduling, audio, sprites...). The
existing single-mega-prompt approach in `generate.ts`'s `buildSystemPrompt()` already
shows strain — real bugs this cycle (wrong hatch picked, token truncation, router
rejecting things it doesn't know exist) all trace back to one model call trying to hold
every mechanism's instructions simultaneously. Adding Phase 2's scope to that same
mega-prompt will make it worse, not better. Do this rearchitecture before the mega-prompt
grows further, not after.

**Design (already discussed and confirmed with Dan):**
1. **Stage 1 — classifier**: a new, small, cheap model call. Input: just the instruction
   (not full spec state — this is about intent, not current state). Output: which genre
   flags apply, from a small fixed set (e.g. `customCSS`, `animation`, `ambientEffect`,
   `reactiveEffect`, `interactiveComponent`, `imageGeneration`, plus whatever new flags
   Phase 2 introduces — `sharedState`, `scheduling`, `audio`, etc.). Zero or more flags;
   empty means a plain token-only change.
2. **Stage 2 — specialist**: `buildSystemPrompt()` dynamically assembles its escape-hatch
   sections based on the classifier's flags. Always include the base token/slot
   instructions (the model must always echo the full theme back faithfully). Only include
   the specific hatch-explanation blocks that are actually relevant to this request.
3. **Graceful degradation**: if the classifier call fails/is unavailable, fall back to
   the current full-mega-prompt behavior (include everything) rather than hard-failing —
   this is an accuracy/focus improvement, not a hard dependency.
4. **Also fix while you're in there**: the ROUTER (`actions.ts`'s `buildRouterPrompt`,
   separate from the theme-generation classifier above) needs to be kept in sync with
   whatever new genres Phase 2 adds — this is exactly the bug class that caused "insert a
   timer" / "add a tic-tac-toe game" to be wrongly rejected before. Every new capability
   added in Phase 2 needs a corresponding update to what the router believes
   `themeInstruction` can cover, or it will reject valid requests before they ever reach
   the specialist.
5. Response envelope contract (`{spec, summary, limitation, backgroundImagePrompt}`)
   stays unchanged — this is a request-shaping change, not a rewrite of the
   validation/dispatch pipeline that already exists downstream
   (`resolveBackgroundImage`, `validateCustomComponents`,
   `validateCustomEffectsSyntax` in `generate.ts`).

---

## Phase 1 — Two backburner architecture items (build before Phase 2 features)

### 1a. Shared, live-synced state (the bigger one — most of Phase 2 depends on this)

**Problem:** `customComponents` currently live inside the personal theme spec
(`member_theme` table, RLS owner-only) — this was inherited from the theme system's
existing personal-scope design, not a deliberate choice for widgets. Consequence: a
generated tic-tac-toe board only renders for the person who asked for it; the other
person can't see it at all. Even if visibility were fixed, the actual game state (whose
turn, board contents) is just local `useState` inside the compiled component — nothing
persists or syncs it.

**Confirmed requirements from Dan:**
- No permission/approval gate — whatever one person sets just applies for both, same
  trust model messages/reactions already have (not a request/accept flow).
- Needs to support: shared to-do lists, live polls, two-player games, shared
  whiteboard/collaborative drawing (Phase 2 items #6, #7, #8, #21).

**Suggested shape (not mandated — use judgment, but this is the shape Dan and Claude
converged on in discussion):**
- A new concept: components can be `scope: "personal"` (current behavior, stays in
  `member_theme`) or `scope: "shared"` (new). Shared components live in a new
  conversation-level table (e.g. `shared_components`: conversation_id, id, label, slot,
  code, created_by, created_at), RLS-readable/writable by any conversation member, synced
  via Realtime the same way messages are — see `subscribeConversation` in `lib/db.ts` for
  the existing pattern to extend.
- Shared components need a NEW state primitive beyond local `useState`: something like a
  `sharedState`/`setSharedState(next)` prop pair passed into the compiled component,
  backed by a small JSONB column (e.g. on the same `shared_components` row, or a sibling
  `shared_component_state` table if you want state updates to be cheaper/more frequent
  than component redefinition). Writes should be optimistic locally + propagate via
  Realtime to the other player, matching the reactions/messages sync pattern already in
  the codebase.
- The model-facing contract for `customComponents` (the code-generation prompt in
  `generate.ts`) needs to explain the new `sharedState`/`setSharedState` props and when to
  use `scope: "shared"` vs `"personal"` — a personal calculator stays personal; a
  tic-tac-toe game or shared to-do list must be `"shared"`.
- Same safety posture as everything else in this codebase: unvalidated content, no
  sandboxing beyond what already exists (error boundary + always-present ✕ removal) —
  Dan has explicitly confirmed this risk tolerance extends to shared state too during
  this conversation, but note shared state has one NEW risk shape worth being honest
  about: a broken/hostile shared component now affects BOTH users, not just the one who
  wrote the instruction. Worth a one-line confirmation with Dan before shipping, not an
  assumption.

### 1b. Conversational memory for the instruction interface

**Problem:** every `/api/generate` and `/api/route` call is stateless — a single user
turn, no history of prior instructions. Current spec state is passed each time, but the
actual back-and-forth about the changes ("make it more like that", "go back to what you
had two changes ago") has no memory. The on-screen "change log" (`log` state in
`Workspace.tsx`) is purely a UI display today — never fed back into any model call.

**Suggested shape:**
- Thread a rolling history (capped — last N instruction/outcome pairs, not the full
  session) into the request body for `/api/generate` and `/api/route`, alongside the
  current spec. Simplest version: reuse the existing `log` array, summarized/truncated,
  no new persistence needed (matches its current ephemeral-per-session nature).
- Decide whether this needs to survive a page reload (would need server-side persistence,
  a new table) or is acceptable as session-only, matching how the change log already
  resets today — check with Dan if this isn't obvious once you're in it; his framing was
  "more of a chat than individual prompts," which may or may not require reload-survival.
- Watch token cost: this grows every request cache-wise; keep the history capped and/or
  summarize older entries rather than sending verbatim.

---

## Phase 2 — Approved feature list

Dan reviewed a long brainstormed list and approved specific items. **Build only what's
marked YES below — do not build anything marked NO, and check in before building the two
UNDECIDED items.** Numbers match the original brainstormed list for traceability.

### Approved (YES)

| # | Feature | Depends on | Notes |
|---|---|---|---|
| 2 | Streaks & milestones (celebrate every 100th message, "one year since we started") | Nothing new | Cheap — `messages` prop already available to `customComponents`, just needs the right prompt/component logic |
| 4 | Reminders & scheduled sends | New: background job/scheduling infra | Real gap — nothing like this exists. Needs a way to fire an action when the user isn't necessarily looking at the tab (client-side `setTimeout` alone won't survive a closed tab) — likely a Supabase Edge Function on a schedule, or a cron-triggered check against a new `reminders` table |
| 6 | Shared to-do list | **Phase 1a (shared state)** | |
| 7 | Live polls (real tallied votes, not the existing static Poll component) | **Phase 1a (shared state)** | |
| 8 | Two-player mini-games (tic-tac-toe, word games, trivia) | **Phase 1a (shared state)** | This is the case that surfaced the whole shared-state gap — start here for a concrete end-to-end test of 1a once it's built |
| 9 | Daily conversation-starter prompts | Maybe scheduling (1a's cron piece) for "daily", or can ship as on-demand first | Could reuse the `generate-response`-style endpoint pattern |
| 10 | "Roast me" / compliment generator | Nothing new | Cheap — same pipeline pattern as `generate-response`/`suggest-replies`, different prompt/persona |
| 11 | Custom avatars | Nothing new | Cheap — reuses the existing `/api/image` (Replicate/Flux) pipeline, just applied to a profile slot instead of background |
| 12 | Custom nicknames per viewer | Nothing new (personal-scoped) | Simple — a personal override of how you see the other person's display name; can live in `member_theme` or a small new field |
| 13 | Accessibility presets (dyslexia-friendly font, high contrast, larger tap targets) | Nothing new | Mostly straightforward new THEME TOKENS, not a new architecture — `fontFamily` already exists as a pattern to extend |
| 14 | Custom notification sounds per event | New: audio pipeline | Ties into the already-agreed "audio" taxonomy gap (see Phase 3) — needs bundled sound assets at minimum, real audio generation is a further option, same bounded-vs-generated tradeoff as images had before Phase 2 shipped image gen |
| 16 | Typing indicators / presence | New: Realtime Presence/Broadcast channels | Approved **conditionally** — Dan said "yes but only if not too difficult." Use judgment: if this turns out to need substantial new infrastructure beyond a straightforward Supabase Presence channel, flag it back to Dan rather than sinking a lot of time in |
| 21 | Shared whiteboard / collaborative drawing | **Phase 1a (shared state)** | The deepest use case of the shared-state primitive — a real-time-synced canvas. Build after 1a is proven out on a simpler case (e.g. #8) |

### Explicitly rejected — do NOT build

| # | Feature | Why rejected |
|---|---|---|
| 3 | Relationship "weather" ambient indicator | Dan doesn't want this pre-built — see note above: the existing dynamic system should already be *able* to attempt this live if he types the request, no dedicated build needed |
| 5 | Bill splitting / expense tracker | Declined |
| 15 | Do-not-disturb windows / quiet hours | Declined |
| 19 | Weather-reactive background | Declined |
| 20 | Time-of-day reactive theme | Declined |

### Undecided — confirm with Dan before building

| # | Feature | Why undecided |
|---|---|---|
| 17 | "On this day" / conversation highlights | Not addressed in Dan's approval pass — don't assume yes or no |
| 18 | Exportable "keepsake" cards | Not addressed in Dan's approval pass — don't assume yes or no |

---

## Phase 3 — Already-agreed taxonomy gaps (separate track, from an earlier discussion)

Dan confirmed wanting all four of these before the creative-list conversation happened —
still valid, fold into sequencing wherever makes sense (audio pairs naturally with #14
above; message-image reuses the existing image pipeline so is likely cheap):

1. **Real generated artwork sent as a message/sticker** (not just background) — likely
   reuses the existing `/api/image` (Replicate/Flux) pipeline, different destination
   (attached to a sent message rather than `wallpaperUrl`).
2. **Content-triggered effects** ("show balloons when someone says happy birthday") —
   needs `customEffects` to see message TEXT and match against it, not just bind to a
   generic event name. Real schema change to `customEffects`, not just a prompt tweak.
3. **Layout/structure** (message side swap, compact/fullscreen mode, sidebar) — flagged
   repeatedly as cheap to add (new theme tokens), never actually built yet.
4. **Sound/audio** (effects and/or ambient) — no audio pipeline exists at all today. Pairs
   directly with Phase 2 item #14.

---

## Reference: current architecture (for orientation, not exhaustive — read the actual
files)

- `src/engine/spec.ts` — the validated spec schema (theme tokens + the four escape
  hatches: `customCSS`, `customCSSText`, `customEffects`, `customComponents`)
- `src/engine/generate.ts` — theme-generation model call, system prompt, response
  validation pipeline (`resolveBackgroundImage`, `validateCustomComponents`,
  `validateCustomEffectsSyntax`)
- `src/engine/actions.ts` — the router (`buildRouterPrompt`), message-action catalog
- `src/components/customComponentRuntime.ts` + `CustomComponentSlot.tsx` — the
  `customComponents` compile/render/error-boundary/removal mechanism
- `api/image.js` — Replicate/Flux integration (version resolution, polling — see
  comments in that file for real gotchas hit during development)
- `supabase/migrations/` — schema + RLS; shared data lives here, personal data in
  `member_theme`
- `FUNCTIONALITY.md` — living capability matrix, keep updated
- `CLAUDE.md` — architecture doc, keep updated when core flows change (it has gone stale
  multiple times before — don't let that happen again)

**Standing project conventions to keep following:**
- Deploy via `git push` to `main` (Vercel auto-deploys) — commit messages should explain
  root cause, not just what changed, matching the existing commit history's style.
- Every model-facing capability needs the ROUTER to know it exists too (Phase 0 above),
  or requests get wrongly rejected before reaching the specialist that could handle them.
- "Compiles/validates" is not "works" — add a real smoke test (see
  `validateCustomComponents`'s `renderToStaticMarkup` pattern) for any new generated-code
  surface, not just a syntax check.
- No silent substitutions — if a request can't be fully honored, say so honestly via the
  `limitation` mechanism rather than quietly doing something else.
