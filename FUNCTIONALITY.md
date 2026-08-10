# Piper — Functionality Matrix

**Last updated:** 2026-08-09  
**Current Phase:** Phase 2 build-out (see `NEXT_PHASE_PLAN.md`) — shared-state primitive (1a) and
conversational memory (1b) shipped, most of the approved feature list built on top of them.
Remaining: reminders/scheduled sends (#4) and notification sounds (#14) need real new
infrastructure and are scoped but not built — see the handoff notes for what they need from Dan.

---

## ✅ FULLY WORKING

### Theme & Appearance (Private to Each User)

| Feature | Status | Details |
|---------|--------|---------|
| Theme tokens | ✅ | Colors, fonts, backgrounds, density, corners, borders, etc. — ~27 tokens |
| Dynamic theme generation | ✅ | Claude understands "green bubbles", "sunset gradient", etc. |
| Theme reset | ✅ | Back to default with undo support |
| Theme randomize | ✅ | Real client-side randomizer (no network call), then legibility-corrected |
| Per-user theme persistence | ✅ | Supabase `member_theme` table, private via RLS |
| Real-time theme sync | ✅ | Changes visible instantly (no page refresh) |
| 8 bundled background scenes | ✅ | mountains, waves, city, forest, desert, aurora, confetti, bokeh |
| **AI-generated background images** | ✅ | `/api/image.js` (Replicate/Flux-schnell), cached by prompt hash in Supabase Storage — "a cartoon dog" now actually generates one instead of falling back to a fixed scene |
| Gradient backgrounds | ✅ | From/via/to colors at custom angle |
| Custom solid colors | ✅ | Any hex color for backgrounds |
| Pattern overlays | ✅ | dots, grid, stripes, checks, crosshatch |
| Custom CSS / animations | ✅ | Free-form CSS per zone + `@keyframes`, for anything tokens can't express (shapes, glows) |
| Custom one-shot effects | ✅ | Model-authored JS run on message/reaction events (confetti, flashes, etc.) |
| **Custom interactive components** | ✅ | Model authors a whole React component (countdown timer, calculator, mini widget), compiled at runtime with `@babel/standalone`. Always removable via a direct ✕ button, independent of the model |

### Message Operations (Shared State)

| Feature | Status | Details |
|---------|--------|---------|
| Send messages | ✅ | Real-time sync via Realtime, all users see it |
| Edit messages | ✅ | Rewrite any message, both users see change instantly |
| Delete messages | ✅ | Soft delete (reversible via undo), delete-for-everyone |
| Translate messages | ✅ | Any language; model resolves "translate to French" |
| Delete all messages from one person | ✅ | Bulk operation, soft-delete |
| Undo all changes | ✅ | Stack of inverse operations, not snapshots |
| Edit history | 🟡 | Message has `edited_at` timestamp, no version log |

### Reactions (Shared State)

| Feature | Status | Details |
|---------|--------|---------|
| Add emoji reactions | ✅ | `reactToMessage`, any single emoji |
| Remove individual reactions | ✅ | `deleteReaction`, toggle-style |
| Remove all reactions from message | ✅ | `deleteAllReactions`, clears emoji list |
| React toggle | ✅ | Same emoji twice removes it (undo-friendly) |
| Aggregated reaction display | ✅ | Shows all reactions on a message, from all users |

### Annotations (Schema Ready, UI Placeholders)

| Feature | Status | Details |
|---------|--------|---------|
| Pin messages | 🟡 | Schema + applier exists, DB fields missing, UI placeholder |
| Unpin messages | 🟡 | Schema + applier exists, DB fields missing, UI placeholder |
| Star/bookmark messages | 🟡 | Schema + applier exists, DB fields missing, UI placeholder |
| Unstar messages | 🟡 | Schema + applier exists, DB fields missing, UI placeholder |

### Query & Analysis (Powered by Claude)

| Feature | Status | Details |
|---------|--------|---------|
| Summarize conversation | ✅ | `/api/summarize`, last 20 messages, 1-2 sentence TLDR |
| Generate AI reply | ✅ | `/api/generate-response`, drafts natural response to last msg |
| Suggest 3 replies | ✅ | `/api/suggest-replies`, different tones/approaches |
| Roast me / compliment me | ✅ | `/api/roast-or-compliment` (Phase 2 #10), one endpoint with a `tone` param. Always targets the requesting viewer specifically (never the other participant), grounded in real conversation content when there's anything usable |
| Custom nicknames per viewer | ✅ | Phase 2 #12: "call Sam 'Sammy'" (`setNickname`/`clearNickname`). PERSONAL only — how you see the other participant's name, never their real profile, never visible to them. New `member_nicknames` table (**needs migration 0005**), kept out of the model-generated Spec entirely so it's never at risk of being silently dropped by a theme-generation call that wasn't told to preserve it |
| Accessibility presets | ✅ | Phase 2 #13: "dyslexia friendly", "high contrast mode", "bigger tap targets" — emergent from existing tokens (fontFamily, bubbleScale, density, colors), no new architecture. Fixed one real correctness bug found while verifying live: "dyslexia friendly" was picking `serif`, which reads as more accessible but is actually harder for dyslexic readers than the sans-serif options — registry hint now steers it to `system`/`rounded` and nudges `bubbleScale`/`density` up for any accessibility-flavored request |
| Custom avatars | ✅ | Phase 2 #11: "make my avatar a cartoon fox" / "give Sam a robot avatar" (`generateAvatar`, optional `authorId`). SHARED, unlike nicknames — an avatar is real identity, so it's a new `avatar_url` column on the existing `profiles` table (**needs migration 0006**) rather than a personal table, reusing profiles' existing RLS as-is. Either participant may set either avatar, no approval step — same trust model as reactions/shared components — but `api/avatar.js` verifies caller and target share a conversation before writing, so this can't be used to deface an arbitrary stranger's profile. Reuses the Replicate/Flux pipeline from background generation (`api/_lib.js`'s `generateImageBuffer`, factored out of `api/image.js`) but the client never gets direct write access to `avatar_url` at all — only `api/avatar.js` (service role) sets it, after generating the image itself, matching the same "model authors a prompt, server owns the URL" trust boundary as `wallpaperUrl`. The chat UI never showed your OWN avatar anywhere by design (header/per-message avatars are always the other person) — added a small self-avatar preview next to the composer so you can confirm your own without needing the other person's session. Not available in local dev, same as background generation |
| Typing indicators | ✅ | Phase 2 #16 (conditionally approved — "only if not too difficult"; genuinely wasn't, since Realtime is already wired up). Own Supabase Realtime BROADCAST channel per conversation, no new table/migration — typing is ephemeral and would be pure write churn as a DB row. No "stopped typing" event exists; a 3s quiet timer clears the indicator client-side instead. Composer input is throttled (2s), not debounced, so the signal starts immediately rather than waiting for a pause. Verified the local demo-mode pub/sub end-to-end (correct sender id, self-echo suppressed, unsubscribe works) — **the Supabase Broadcast path itself is NOT verified against real Postgres/Realtime**, same caveat as the append-state RPC before it |
| All queries are metered | ✅ | Count against daily per-user API cap |

### Conversations

| Feature | Status | Details |
|---------|--------|---------|
| Create conversation | ✅ | Auto-create on first sign-in, one per user |
| Rename conversation | ✅ | `updateConversationTitle`, persisted in DB |
| Clear all messages | ✅ | `clearConversation`, soft-delete, reversible via undo |
| Invite via code | ✅ | `/join/abc123` path-based invite links, survives auth redirects |
| Magic link auth | ✅ | Supabase OTP, email-based, no password |
| 2-user rooms | ✅ | Peer-to-peer conversations, invite code adds one person |
| Real-time message sync | ✅ | Supabase Realtime, <500ms propagation |

### Router & Instruction Understanding

| Feature | Status | Details |
|---------|--------|---------|
| Natural language routing | ✅ | Claude understands 17+ action types |
| Message reference resolution | ✅ | "the one that says X", "my last message", "Sam's first text" |
| Bounded action vocabulary | ✅ | Can't request impossible things, gets clear explanation |
| Keyword fast-path | ✅ | Free theme-only changes (no API call) for patterns like "green" |
| Feasibility detection | ✅ | Router explains why something isn't possible |
| Compound requests | ✅ | "make my bubbles green and delete my last message" → both actions |
| Classify-then-dispatch theming | ✅ | Theme generation is two calls: a cheap classifier picks which mechanisms the request needs, then the specialist prompt carries only those (51–70% of the old every-mechanism prompt) |
| Classifier degradation | ✅ | A failed classifier call falls back to the full prompt; a no-op result escalates to the full prompt + `claude-opus-4-8`, so a misclassification costs latency, not capability |
| Capability catalog | ✅ | `engine/genres.ts` is the single source for what `themeInstruction` can produce; the router's capability list is generated from it, so it can't drift behind the engine and reject things that work |
| Shared custom components | ✅ | `scope:"shared"` components live in a conversation table, render for both people, and sync via Realtime — the prerequisite for two-player games, shared lists and live polls |
| Shared component state | ✅ | `sharedState`/`setSharedState` props, backed by a separate state table so a move doesn't re-broadcast the component's source. Optimistic local write, last-write-wins on conflict |
| Undo across scopes | ✅ | Removing a shared component is undoable and restores the state the delete cascaded away, not just the component |
| Shared to-do lists | ✅ | Emergent from the shared-state primitive — generated on request, not hand-built. Verified through the full router → classify → generate → compile → render path |
| Live polls with real votes | ✅ | "add a poll" now builds a shared component both people vote in, with counts in `sharedState`. The old static `Poll` mockup is deprecated: still valid in saved specs, no longer offered to the model |
| Two-player mini-games | ✅ | Tic-tac-toe, word games and trivia generate as shared components using `setSharedState` for turn-taking. Emergent from the primitive, not hand-built |
| Shared whiteboard / drawing | ✅ | Generates using the atomic `appendSharedState` so simultaneous strokes from both people survive. **Needs migration 0004**. Fixed a real quality bug found via user testing: the model was appending per-POINT instead of per-STROKE, which renders as jumpy lines that self-connect across separate strokes, plus a non-functional color picker and a bare crosshair cursor. `genres.ts` now carries an exact worked pattern (collect points locally during the drag, append ONE stroke object on pointer-up, one `<polyline>` per stroke, a brush-sized circle cursor). Re-verified live and via the same compile+render smoke test the real pipeline uses (`compileCustomComponent` + `renderToStaticMarkup`) |
| Concurrent-safe shared writes | ✅ | `appendSharedState(listKey, item)` appends inside Postgres in one statement. `setSharedState` still replaces (correct for turn-based), so the model is told: if both people could act at the same instant, append |
| Conversational memory | ✅ | The last 8 instruction/outcome pairs ride along with `/api/route` and `/api/generate`, so "make it more like that", "a bit less", "undo that and try again" resolve. Session-only — resets on reload, like the change log always has |
| Streaks & milestones ("celebrate every 100th message") | ✅ | Emergent from `interactiveComponent` — the model reads the real `messages` array and filters/counts accurately. Required two prompt fixes: nudging the classifier toward `interactiveComponent` (not `reactiveEffect`, which has no memory of prior counts) for anything gated on a true running count, and documenting the actual message shape (`authorId`, `isMine`, `time`, not guessed field names like `senderId`) so generated code reads real fields instead of silently-undefined ones |

### Infrastructure & Security

| Feature | Status | Details |
|---------|--------|---------|
| Supabase auth | ✅ | Row-level security via auth.uid() |
| JWT verification | ✅ | All APIs verify Supabase JWT |
| Rate limiting | ✅ | Per-user daily spend cap on model + image generation |
| Input validation | ✅ | Message length limits, emoji length caps, title length |
| Soft deletes only | ✅ | No permanent data loss within session (undo works) |
| Two-layer permission checks | ✅ | Client-side + RLS at database |
| API key isolation | ✅ | ANTHROPIC_API_KEY server-side only, never in bundle |

---

## 🟡 PARTIALLY WORKING / NEEDS COMPLETION

| Feature | Status | Why | Next Step |
|---------|--------|-----|-----------|
| Pins & stars | 🟡 | Schema exists, no DB fields | Add `pins` & `starred` tables |
| Message grouping | 🟡 | Conceptually possible, complex UI | Design nested message rendering |
| Filter by author | 🟡 | Schema exists, needs Workspace state | Add `authorFilter` state, UI list |
| Undo older than current session | 🟡 | Stack only holds current session | Implement version history table |

---

## ❌ NOT POSSIBLE (Architectural Constraints)

### Multi-User & Group Chats

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Group conversations (N users)** | Schema designed for peer-to-peer via invite_code. Supporting N users needs: conversation_members query refactor, UI member list, permissions matrix, group invite flow. | Architectural | Phase 3 |
| **Conversation discovery** | Rooms are invite-only. Discovery would need: public room list, join requests, room browsing, moderation. | Design decision | Phase 3+ |
| **User profiles** | Only email stored. Custom profiles need: avatar upload, bio, display name edit, settings page. | Schema | Phase 2 |
| **User presence/online status** | Would need Realtime Broadcast channels for ephemeral data. Adds complexity. | Architecture | Phase 3 |
| **Typing indicators** | Same as presence; Broadcast channels + debouncing. | Architecture | Phase 3 |
| **Read receipts** | Need `read_at` timestamps + RLS. Possible but adds table & sync overhead. | Schema | Phase 3 |

### Message Features

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Message search** | Would need full-text index (PostgreSQL) or external search (Elasticsearch/Algolia). Significant infrastructure. | Scale | Phase 3 |
| **Message threading/replies** | Would need parent_message_id FK + nested rendering. Changes message UX completely. | Architecture | Phase 3 |
| **Message scheduling** | Would need a job queue (Bull/RabbitMQ) + background worker. | Infrastructure | Phase 4 |
| **Message grouping UI** | Conceptually possible but rendering nested messages is complex. | Frontend | Phase 3 |
| **Polls** | Schema exists but UI not implemented. Table `polls` + `poll_votes` ready. | Frontend | Phase 2 |
| **GIF picker** | Could integrate Giphy/Tenor API but adds external dependency. | Scope | Phase 2 |
| **Emoji picker** | Could use a library but users can paste emojis directly. | Nice-to-have | Phase 3 |

### Media & Files

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Image attachments** | Need Supabase Storage setup + file upload UI + MIME validation + virus scan. | Infrastructure | Phase 3 |
| **Voice notes** | Need recording API (Web Audio API) + MP3 encoding + Supabase Storage. | Infrastructure | Phase 3 |
| **Video** | Bandwidth + streaming concerns. FFmpeg transcoding. | Infrastructure | Phase 4+ |
| **File attachments** | Same as images: upload, storage, virus scan. | Infrastructure | Phase 3 |

### Mobile & PWA

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Mobile responsiveness** | Current layout is desktop-only. Would need: breakpoints, touch gestures, mobile nav. | Frontend | Phase 3 |
| **PWA / offline support** | Would need Service Worker + IndexedDB/SQLite + sync queue. Complex. | Infrastructure | Phase 3+ |
| **Sync across devices** | Would need device registry + device-aware subscriptions. | Schema | Phase 4 |
| **Mobile app (native)** | Would need React Native rewrite or Electron. | Scope | Phase 4+ |

### Advanced Features

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Message backup/export** | Could dump JSON but needs: export format design, chunking for large convos, storage option. | Frontend | Phase 3 |
| **Import messages** | Format parsing + migration logic. Risky (data corruption). | Complexity | Phase 4+ |
| **Conversation archiving** | Low priority; soft-deletes achieve similar goal. | Scope | Phase 4 |
| **Conversation deletion** | Could add, but soft-deletes are safer. | Policy | Phase 4 |
| **Session/device management UI** | Could show active sessions but low priority. | Scope | Phase 4 |
| **Two-factor authentication** | Supabase supports it but adds UX complexity. | Scope | Phase 4 |
| **End-to-end encryption** | Would need TweetNaCl.js or libsodium.js + key management. Trust model changes. | Scope | Phase 5 |
| **Content moderation** | Would need ML (OpenAI Moderation API) + flagging UI + review queue. | Infrastructure | Phase 4 |
| **Message reactions beyond emoji** | Currently emoji only. Could support animated GIFs, stickers, but UI complex. | Scope | Phase 3+ |

### Performance & Scale

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Infinite scroll / pagination** | Currently loads all messages at once. Would need cursor-based pagination + UI refactor. | Frontend | Phase 2 |
| **Message compression** | Messages are text, not large. Premature optimization. | Scope | Phase 5+ |
| **Conversation list** | Only one conversation per user. Not needed until groups. | Schema | Phase 3 |
| **Full-text search** | Requires PostgreSQL FTS setup or external search engine. | Infrastructure | Phase 3 |

### Personalization

| Feature | Why Not | Blocker | Phase |
|---------|---------|---------|-------|
| **Dark mode toggle** | Could be done at app level but theme already handles it. | Redundant | — |
| **Notification settings** | No notifications implemented yet (Phase 3). | Architecture | Phase 3 |
| **Account settings page** | Could build but low priority. | Frontend | Phase 3 |
| **Display name customization** | Uses Supabase profile.display_name but UI to edit doesn't exist. | Frontend | Phase 2 |
| **Avatar upload** | Could use Supabase Storage but no UI. | Frontend | Phase 2 |

---

## 📊 Summary

### What Makes This Work
- **Bounded, validated action vocabulary** — safety via schema, not by limiting possibility
- **Natural language router** — Claude understands intent, fills parameters, appliers execute
- **Row-level security** — Postgres RLS enforces scope (personal vs shared) at DB layer
- **Real-time Supabase** — Messages propagate <500ms, no polling
- **Undo via inverse operations** — each action stores its reverse, not snapshots
- **Per-user theme** — spec stored privately, renderers apply it, no cross-user visibility

### What Would Unlock More
1. **Groups** (Phase 3) — Add `conversation_members` query, member mgmt UI
2. **Media** (Phase 3) — Storage + upload handlers
3. **Presence** (Phase 3) — Broadcast channels + ephemeral subscriptions
4. **Search** (Phase 3) — Full-text index or external search
5. **Threading** (Phase 3) — parent_message_id + nested rendering
6. **Mobile** (Phase 3) — Responsive layout + touch handlers
7. **Mobile offline** (Phase 3+) — Service Worker + IndexedDB + sync queue
8. **Encryption** (Phase 5) — TweetNaCl.js + key exchange
9. **E2E features** (Phase 4+) — Moderation, compliance, analytics

---

## 🎯 Design Philosophy

**Piper is intentionally constrained to stay safe and understandable.**

- Actions are validated before execution (schema → validator → applier)
- No dynamic code generation (model fills parameters, not writes code)
- No silent failures (user gets explanation, not a 403)
- Data is immutable once shared (soft deletes only, no overwrites)
- UI is single-user (no admin panel, no moderation queue) — Phase 1 is two friends

Future phases will gradually relax these constraints as the product scales from 1:1 to groups to communities.

