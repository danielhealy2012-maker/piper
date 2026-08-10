import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import type { TranslationEntry } from "./components/slots";
import { generateSpec, keywordOnly } from "./engine/generate";
import { randomizeSpec } from "./engine/randomize";
import { routeInstruction } from "./engine/route";
import { formatHistory } from "./engine/history";
import { translateText } from "./engine/translate";
import { generateResponse, suggestReplies, summarizeConversation, roastOrCompliment } from "./lib/queries";
import { errorMessage } from "./lib/errors";
import { DEFAULT_SPEC, type Spec } from "./engine/spec";
import type { ChatBackend, DisplayUser, SharedComponentRecord } from "./lib/backend";
import type { ChatMessage } from "./lib/types";

interface LogEntry {
  instruction: string;
  summary: string;
  matched: boolean;
  // Presentation only — history.ts (which feeds the model) only ever reads
  // `matched`. "clarifying": Piper asked a question instead of acting.
  // "conversational": a genuine Q&A/comment turn, feasible:true with no
  // action taken — NOT a failure, so it must not read as one. "applied"/
  // "failed" are what `matched` already meant, just named for the UI.
  kind: "applied" | "clarifying" | "conversational" | "failed";
}

/** Undo is a stack of INVERSE OPERATIONS, not state snapshots. With a shared
 *  realtime conversation, restoring a whole snapshot would clobber messages the
 *  other participant sent in the meantime. */
interface UndoOp {
  label: string;
  run: () => Promise<void> | void;
}

export interface WorkspaceProps {
  backend: ChatBackend;
  /** Local demo only: lets you flip between the two fake participants. */
  onSwitchViewer?: (id: string) => void;
  headerSlot?: React.ReactNode;
}

export function Workspace({ backend, onSwitchViewer, headerSlot }: WorkspaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<DisplayUser[]>([]);
  // The PERSONAL spec — what gets written to member_theme. Shared components
  // are deliberately not in here; see composedSpec below.
  const [spec, setSpec] = useState<Spec>(DEFAULT_SPEC);
  // PERSONAL: how the viewer sees the other participant's name. Keyed by
  // their real user id, never the viewer's own — see backend.getNicknames.
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [sharedComponents, setSharedComponents] = useState<SharedComponentRecord[]>([]);
  const [sharedState, setSharedState] = useState<Record<string, unknown>>({});
  const [translations, setTranslations] = useState<Record<string, TranslationEntry>>({});
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const [queryResult, setQueryResult] = useState<{
    type: "summary" | "reply" | "suggestions" | "roast" | "compliment";
    content: string | string[];
  } | null>(null);
  const [pinnedMessageIds, setPinnedMessageIds] = useState<Set<string>>(new Set());
  const [starredMessageIds, setStarredMessageIds] = useState<Set<string>>(new Set());
  // Set when the router asked a clarifying question instead of guessing — the
  // NEXT instruction the user types is treated as the answer and merged with
  // this original instruction rather than run standalone.
  const [pendingClarification, setPendingClarification] = useState<string | null>(null);
  // Phase 2 #16. The other participant's id while they're actively typing,
  // else null. No explicit "stopped typing" signal exists (broadcast-only,
  // no state to clear) — a timer clears it after a quiet period instead, see
  // the typing-subscribe effect below.
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Fires on every realtime event, so it must pull everything SHARED: the
  // other person's message, the widget they just added, and their move inside
  // it. Shared component state is exactly as live as messages are because it
  // refetches on the same signal.
  const refresh = useCallback(async () => {
    console.log("[refresh] fetching shared state...");
    // getUsers() belongs in this refetch, not just the initial-load effect —
    // profiles (avatar, display name) changes fire the SAME onChange signal
    // as messages/shared state (see subscribeConversation), but this
    // function is what that signal actually calls. Without users included
    // here, the person who made an avatar change saw it instantly via their
    // own local setUsers() call right after the action, while the OTHER
    // participant's session had the correct Realtime event firing and doing
    // nothing with it — indistinguishable from Realtime not working at all
    // until you look at what refresh() actually refetches.
    const [msgs, components, state, nextUsers] = await Promise.all([
      backend.fetchMessages(),
      backend.fetchSharedComponents(),
      backend.fetchSharedState(),
      backend.getUsers(),
    ]);
    console.log("[refresh] got", msgs.length, "messages,", components.length, "shared components");
    setMessages(msgs);
    setSharedComponents(components);
    setSharedState(state);
    setUsers(nextUsers);
  }, [backend]);

  // Initial load + realtime subscription.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [nextUsers, nextMessages, nextSpec, nextShared, nextSharedState, nextNicknames] = await Promise.all([
        backend.getUsers(),
        backend.fetchMessages(),
        backend.loadTheme(),
        backend.fetchSharedComponents(),
        backend.fetchSharedState(),
        backend.getNicknames(),
      ]);
      if (!alive) return;
      setUsers(nextUsers);
      setMessages(nextMessages);
      setSpec(nextSpec);
      setSharedComponents(nextShared);
      setSharedState(nextSharedState);
      setNicknames(nextNicknames);
      setTranslations({});
      setLog([]);
      setUndoStack([]);
    })();
    const unsubscribe = backend.subscribe(() => void refresh());
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [backend, refresh]);

  // Typing indicator: separate subscription from the one above, since a
  // typing event must never trigger a full messages/shared-state refetch.
  // No "stopped typing" event exists, so a 3s quiet timer clears it instead —
  // long enough to survive normal inter-keystroke gaps, short enough that a
  // closed tab doesn't leave a stale "typing…" showing indefinitely.
  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = backend.subscribeTyping((fromUserId) => {
      setTypingUserId(fromUserId);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setTypingUserId(null), 3000);
    });
    return () => {
      clearTimeout(clearTimer);
      unsubscribe();
      setTypingUserId(null);
    };
  }, [backend]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(t);
  }, [notice]);

  // Throttled, not debounced: a debounce would wait for the user to PAUSE
  // typing before sending anything, which is backwards for a live "is
  // typing" signal — the other person should see it start immediately, this
  // just caps how often re-typing re-sends it.
  const lastTypingSentRef = useRef(0);
  const handleTypingChange = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    backend.sendTyping();
  }, [backend]);

  const pushUndo = (op: UndoOp) => setUndoStack((prev) => [...prev, op]);

  async function undo() {
    const op = undoStack[undoStack.length - 1];
    if (!op) return;
    setUndoStack((prev) => prev.slice(0, -1));
    await op.run();
    await refresh();
    setNotice(null);
  }

  // The spec as the USER and the MODEL see it: personal components plus the
  // conversation's shared ones, which live in a different table entirely. The
  // model has to be shown both or it can't modify or remove a shared widget
  // ("make the tic-tac-toe board bigger") — it would look to it like the thing
  // doesn't exist. Everything written back out is split again by persistSpec.
  const composedSpec = useMemo<Spec>(() => {
    const sharedAsComponents = sharedComponents.map((c) => ({
      id: c.id,
      label: c.label,
      slot: c.slot,
      code: c.code,
      scope: "shared" as const,
    }));
    const sharedIds = new Set(sharedAsComponents.map((c) => c.id));
    return {
      ...spec,
      customComponents: [
        // A personal component whose id collides with a shared one would
        // otherwise duplicate the React key and render twice; shared wins,
        // since that's the copy both people can see.
        ...spec.customComponents.filter((c) => !sharedIds.has(c.id)),
        ...sharedAsComponents,
      ],
    };
  }, [spec, sharedComponents]);

  /**
   * The single write path for a new spec, and the only place the two scopes
   * are separated. Whatever comes in — from the keyword stub, the model, a
   * reset, or an undo — personal content goes to member_theme and
   * scope:"shared" components go to the conversation table.
   *
   * Routing on the way OUT (rather than asking callers to pre-split) is what
   * stops a shared component leaking into the personal spec: the keyword stub,
   * for instance, structuredClones whatever spec it's handed, so it would
   * happily copy the shared tic-tac-toe board into member_theme and leave a
   * private duplicate behind.
   *
   * Returns its own inverse for the undo stack.
   */
  async function persistSpec(next: Spec): Promise<UndoOp> {
    const previousSpec = spec;
    const previousShared = sharedComponents;

    const personal = next.customComponents.filter((c) => c.scope !== "shared");
    const shared = next.customComponents.filter((c) => c.scope === "shared");
    const personalSpec: Spec = { ...next, customComponents: personal };

    setSpec(personalSpec);
    await backend.saveTheme(personalSpec);

    const nextIds = new Set(shared.map((c) => c.id));
    const removed = previousShared.filter((c) => !nextIds.has(c.id));
    const changed = shared.filter((c) => {
      const before = previousShared.find((p) => p.id === c.id);
      return !before || before.code !== c.code || before.label !== c.label || before.slot !== c.slot;
    });

    // Snapshot the state of anything being removed BEFORE the delete cascades
    // it away. Without this, undoing the removal of a game brings the board
    // back empty — the component is restored but every move is gone, which is
    // silent data loss dressed up as a successful undo.
    const removedState = Object.fromEntries(removed.map((c) => [c.id, sharedState[c.id]]));

    for (const c of removed) await backend.removeSharedComponent(c.id);
    for (const c of changed) {
      await backend.saveSharedComponent({ id: c.id, label: c.label, slot: c.slot, code: c.code });
    }
    if (removed.length > 0 || changed.length > 0) {
      setSharedComponents(
        shared.map((c) => ({
          id: c.id,
          label: c.label,
          slot: c.slot,
          code: c.code,
          createdBy: previousShared.find((p) => p.id === c.id)?.createdBy ?? backend.viewerId,
        })),
      );
    }

    return {
      label: "theme",
      run: async () => {
        setSpec(previousSpec);
        await backend.saveTheme(previousSpec);
        // Restore the shared set exactly: re-add what this change removed,
        // drop what it added, and revert code edits to anything it modified.
        const previousIds = new Set(previousShared.map((c) => c.id));
        for (const c of shared) if (!previousIds.has(c.id)) await backend.removeSharedComponent(c.id);
        for (const c of previousShared) {
          await backend.saveSharedComponent({ id: c.id, label: c.label, slot: c.slot, code: c.code });
        }
        // Re-seed the state that the delete cascaded away. Ordered after the
        // component rows exist, since the state table's foreign key points at
        // them.
        for (const [id, state] of Object.entries(removedState)) {
          if (state !== undefined) await backend.setSharedState(id, state);
        }
        setSharedComponents(previousShared);
        setSharedState((prev) => ({ ...prev, ...removedState }));
      },
    };
  }

  async function applyTheme(next: Spec, _previous: Spec) {
    pushUndo(await persistSpec(next));
  }

  // Optimistic local write, then propagate — the same shape as sending a
  // message. The other person's copy updates through the Realtime
  // subscription on shared_component_state, which is what makes a move in a
  // two-player game show up on their board.
  const handleSetSharedState = useCallback(
    async (componentId: string, next: unknown) => {
      setSharedState((prev) => ({ ...prev, [componentId]: next }));
      try {
        await backend.setSharedState(componentId, next);
      } catch (err) {
        // Don't leave the UI showing a move that never landed.
        console.error("[sharedState] write failed:", err);
        setNotice(`Couldn't sync that change (${errorMessage(err)}).`);
        await refresh();
      }
    },
    [backend, refresh],
  );

  // Deliberately NOT optimistic, unlike setSharedState above. The whole point
  // of an append is that the authoritative order is decided server-side when
  // writers race; guessing locally and then being corrected by the refetch
  // would make strokes visibly jump. The realtime echo lands in well under a
  // frame's worth of perceptible delay for this use.
  const handleAppendSharedState = useCallback(
    async (componentId: string, listKey: string, item: unknown) => {
      try {
        await backend.appendSharedState(componentId, listKey, item);
        await refresh();
      } catch (err) {
        console.error("[sharedState] append failed:", err);
        setNotice(`Couldn't sync that change (${errorMessage(err)}).`);
      }
    },
    [backend, refresh],
  );

  async function handleSend(text: string) {
    await backend.send(text);
    await refresh();
  }

  // The guaranteed, model-independent way to get rid of a misbehaving custom
  // component — see CustomComponentSlot.tsx. Never blocked on a model call.
  //
  // For a SHARED component this removes it for both people, which is the
  // deliberate trade: a shared widget that's broken or misbehaving is broken
  // for both, so either person must be able to kill it without waiting on the
  // other. It stays undoable like every other destructive action here.
  async function removeCustomComponent(id: string) {
    const next = {
      ...composedSpec,
      customComponents: composedSpec.customComponents.filter((c) => c.id !== id),
    };
    pushUndo(await persistSpec(next));
  }

  async function handleTranslate(messageId: string, target: string) {
    const current = translations[messageId];
    if (current?.status === "loading") return;
    if (current?.status === "shown") {
      setTranslations((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      return;
    }
    const message = messages.find((m) => m.id === messageId);
    if (!message) return;
    setTranslations((prev) => ({ ...prev, [messageId]: { status: "loading" } }));
    const result = await translateText(message.text, target);
    setTranslations((prev) => ({
      ...prev,
      [messageId]:
        result.ok && result.sameLanguage
          ? { status: "error", error: "already in that language" }
          : result.ok
            ? { status: "shown", text: result.text }
            : { status: "error", error: result.error },
    }));
  }

  const logResult = (instructionText: string, summary: string, matched: boolean, kind?: LogEntry["kind"]) =>
    setLog((prev) => [
      ...prev,
      { instruction: instructionText, summary, matched, kind: kind ?? (matched ? "applied" : "failed") },
    ]);

  async function runInstruction(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      // If we're mid-clarification, this instruction is the answer — merge it
      // with the original ask rather than running it standalone, and always
      // go through the router (the fast path can't resolve an ambiguity).
      const answeringClarification = pendingClarification !== null;
      const effectiveInstruction = answeringClarification
        ? `${pendingClarification} (clarification from user: ${trimmed})`
        : trimmed;
      if (answeringClarification) setPendingClarification(null);

      // Prior turns of this session, so "make it more like that", "a bit less",
      // "undo that and try again" resolve to something. Snapshotted BEFORE
      // this turn is logged, so the model never sees the instruction it's
      // currently being asked to carry out listed as already-done history.
      const history = formatHistory(log);

      // 1. Free keyword fast-path (personal theme only).
      if (!answeringClarification) {
        const kw = keywordOnly(trimmed, composedSpec);
        if (kw) {
          await applyTheme(kw.spec, composedSpec);
          logResult(trimmed, kw.summary, true);
          setNotice(null);
          setInstruction("");
          return;
        }
      }

      // 2. Router.
      const routed = await routeInstruction(effectiveInstruction, messages, users, backend.viewerId, history);

      if (routed.status === "unavailable") {
        const r = await generateSpec(effectiveInstruction, composedSpec, history);
        if (r.matched) {
          await applyTheme(r.spec, composedSpec);
          logResult(trimmed, r.limitation ? `${r.summary} — ${r.limitation}` : r.summary, true);
          setNotice(r.limitation ?? null);
        } else {
          logResult(trimmed, r.summary, false);
          setNotice(r.summary);
        }
        setInstruction("");
        return;
      }
      if (routed.status === "invalid") {
        const msg = "I couldn't turn that into a valid change — try rephrasing it.";
        logResult(trimmed, msg, false);
        setNotice(msg);
        setInstruction("");
        return;
      }

      // 2.5. Router asked a clarifying question instead of guessing — surface
      // it and wait for the next instruction to be the answer.
      if (routed.plan.needsClarification) {
        const question = routed.plan.reply || "Could you clarify what you mean?";
        setPendingClarification(effectiveInstruction);
        // Not setNotice(question) — the question now shows in the threaded
        // chat log itself (via logResult below), so the separate amber/blue
        // notice banner would just be a duplicate of what's already on screen.
        logResult(trimmed, question, false, "clarifying");
        setInstruction("");
        return;
      }

      // 3. Execute the plan.
      const plan = routed.plan;
      const applied: string[] = [];
      const notes: string[] = [];
      const inverses: UndoOp[] = [];

      // Handle theme mutations (reset, randomize).
      //
      // Both deliberately KEEP the conversation's shared components. "Reset my
      // theme" is a personal appearance action, and silently deleting a game
      // or to-do list the other person is also using — for both of you — is a
      // much bigger consequence than the request implies. Removing a shared
      // widget stays an explicit act: its ✕, or asking for it by name.
      const keepShared = composedSpec.customComponents.filter((c) => c.scope === "shared");
      if (plan.themeMutation === "reset") {
        inverses.push(await persistSpec({ ...DEFAULT_SPEC, customComponents: keepShared }));
        applied.push("reset theme");
      } else if (plan.themeMutation === "randomize") {
        inverses.push(await persistSpec(randomizeSpec(composedSpec)));
        applied.push("randomized theme");
      }

      // Handle theme instruction (appearance request)
      if (plan.themeInstruction) {
        const r = await generateSpec(plan.themeInstruction, composedSpec, history);
        if (r.matched) {
          inverses.push(await persistSpec(r.spec));
          applied.push(r.summary);
          // A substitution ("asked for a dog, got the closest bundled scene")
          // must never be silent — surface it distinctly from a normal note.
          if (r.limitation) notes.push(r.limitation);
        } else {
          notes.push(r.summary);
        }
      }

      // Handle conversation operations
      if (plan.conversationTitle) {
        try {
          await backend.updateTitle(plan.conversationTitle);
          applied.push(`renamed to "${plan.conversationTitle}"`);
        } catch (err) {
          notes.push("couldn't rename conversation");
        }
      }

      if (plan.clearConversation) {
        try {
          await backend.clearMessages();
          applied.push("cleared all messages");
        } catch (err) {
          notes.push("couldn't clear messages");
        }
      }

      for (const action of plan.messageActions) {
        // Actions that require a messageId: find the message
        if ("messageId" in action) {
          const message = messages.find((m) => m.id === action.messageId);
          if (!message) {
            notes.push("couldn't find that message");
            continue;
          }

          switch (action.kind) {
            case "editMessage": {
              const previousText = message.text;
              await backend.edit(action.messageId, action.newText);
              inverses.push({
                label: "edit",
                run: () => backend.edit(action.messageId, previousText),
              });
              applied.push("edited a message");
              break;
            }
            case "deleteMessage":
              await backend.remove(action.messageId);
              inverses.push({ label: "delete", run: () => backend.unremove(action.messageId) });
              applied.push("deleted a message");
              break;
            case "reactToMessage":
              await backend.react(action.messageId, action.emoji);
              inverses.push({
                label: "react",
                run: () => backend.react(action.messageId, action.emoji),
              });
              applied.push(`reacted ${action.emoji}`);
              break;
            case "deleteReaction": {
              const removed = await backend.unreact(action.messageId, action.emoji);
              if (removed) {
                inverses.push({
                  label: "deleteReaction",
                  run: () => backend.react(action.messageId, action.emoji),
                });
                applied.push(`removed ${action.emoji}`);
              } else {
                notes.push(`you haven't reacted with ${action.emoji} on that message`);
              }
              break;
            }
            case "deleteAllReactions": {
              const removedEmojis = await backend.unreactAll(action.messageId);
              if (removedEmojis.length > 0) {
                inverses.push({
                  label: "deleteAllReactions",
                  run: async () => {
                    for (const emoji of removedEmojis) await backend.react(action.messageId, emoji);
                  },
                });
                applied.push(`removed ${removedEmojis.length} reaction${removedEmojis.length === 1 ? "" : "s"}`);
              } else {
                notes.push("you have no reactions on that message to remove");
              }
              break;
            }
            case "translateMessage": {
              const result = await translateText(message.text, action.targetLanguage);
              if (result.ok && result.sameLanguage) {
                notes.push(`that message is already in ${action.targetLanguage}`);
              } else if (result.ok) {
                const id = action.messageId;
                setTranslations((prev) => ({ ...prev, [id]: { status: "shown", text: result.text } }));
                inverses.push({
                  label: "translate",
                  run: () =>
                    setTranslations((prev) => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    }),
                });
                applied.push(`translated to ${action.targetLanguage}`);
              } else {
                notes.push(`translation failed (${result.error})`);
              }
              break;
            }
            case "pinMessage":
              setPinnedMessageIds((prev) => new Set([...prev, action.messageId]));
              inverses.push({
                label: "unpin",
                run: () => setPinnedMessageIds((prev) => {
                  const next = new Set(prev);
                  next.delete(action.messageId);
                  return next;
                }),
              });
              applied.push(`pinned "${message.text.slice(0, 20)}..."`);
              break;
            case "unpinMessage":
              setPinnedMessageIds((prev) => {
                const next = new Set(prev);
                next.delete(action.messageId);
                return next;
              });
              inverses.push({
                label: "repin",
                run: () => setPinnedMessageIds((prev) => new Set([...prev, action.messageId])),
              });
              applied.push("unpinned");
              break;
            case "starMessage":
              setStarredMessageIds((prev) => new Set([...prev, action.messageId]));
              inverses.push({
                label: "unstar",
                run: () => setStarredMessageIds((prev) => {
                  const next = new Set(prev);
                  next.delete(action.messageId);
                  return next;
                }),
              });
              applied.push("starred");
              break;
            case "unstarMessage":
              setStarredMessageIds((prev) => {
                const next = new Set(prev);
                next.delete(action.messageId);
                return next;
              });
              inverses.push({
                label: "restar",
                run: () => setStarredMessageIds((prev) => new Set([...prev, action.messageId])),
              });
              applied.push("unstarred");
              break;
          }
        }

        // Actions that don't require a messageId. `continue` (not `break`) —
        // this is one iteration of a loop over possibly-multiple actions in
        // the plan; `break` would silently abandon every action after this
        // one in a compound instruction.
        if (action.kind === "deleteAllMessagesBy") {
          if (!users.some((u) => u.id === action.authorId)) {
            notes.push("couldn't identify which person you meant");
            continue;
          }
          const deletedIds = await backend.removeAllBy(action.authorId);
          if (deletedIds.length > 0) {
            inverses.push({
              label: "deleteAllBy",
              run: async () => {
                for (const id of deletedIds) await backend.unremove(id);
              },
            });
            applied.push(`deleted ${deletedIds.length} message${deletedIds.length === 1 ? "" : "s"}`);
          } else {
            notes.push("that person has no messages to delete");
          }
          continue;
        }

        if (action.kind === "summarizeConversation") {
          const result = await summarizeConversation(messages, users);
          if (result.ok && result.summary) {
            setQueryResult({ type: "summary", content: result.summary });
            applied.push("generated summary");
          } else {
            notes.push(`couldn't summarize (${result.error})`);
          }
          continue;
        }

        if (action.kind === "generateResponse") {
          const result = await generateResponse(messages, users);
          if (result.ok && result.response) {
            setQueryResult({ type: "reply", content: result.response });
            applied.push("generated reply");
          } else {
            notes.push(`couldn't generate reply (${result.error})`);
          }
          continue;
        }

        if (action.kind === "suggestReplies") {
          const result = await suggestReplies(messages, users);
          if (result.ok && result.replies) {
            setQueryResult({ type: "suggestions", content: result.replies });
            applied.push("suggested 3 replies");
          } else {
            notes.push(`couldn't suggest replies (${result.error})`);
          }
          continue;
        }

        if (action.kind === "roastMe") {
          const result = await roastOrCompliment(messages, users, backend.viewerId, "roast");
          if (result.ok && result.message) {
            setQueryResult({ type: "roast", content: result.message });
            applied.push("roasted you");
          } else {
            notes.push(`couldn't roast you (${result.error})`);
          }
          continue;
        }

        if (action.kind === "complimentMe") {
          const result = await roastOrCompliment(messages, users, backend.viewerId, "compliment");
          if (result.ok && result.message) {
            setQueryResult({ type: "compliment", content: result.message });
            applied.push("complimented you");
          } else {
            notes.push(`couldn't compliment you (${result.error})`);
          }
          continue;
        }

        if (action.kind === "setNickname") {
          if (!users.some((u) => u.id === action.authorId)) {
            notes.push("couldn't identify which person you meant");
            continue;
          }
          const previous = nicknames;
          const next = { ...nicknames, [action.authorId]: action.nickname };
          setNicknames(next);
          await backend.saveNicknames(next);
          inverses.push({
            label: "setNickname",
            run: async () => {
              setNicknames(previous);
              await backend.saveNicknames(previous);
            },
          });
          applied.push(`set nickname to "${action.nickname}"`);
          continue;
        }

        if (action.kind === "clearNickname") {
          const previous = nicknames;
          if (!(action.authorId in previous)) {
            notes.push("that person doesn't have a nickname set");
            continue;
          }
          const next = { ...previous };
          delete next[action.authorId];
          setNicknames(next);
          await backend.saveNicknames(next);
          inverses.push({
            label: "clearNickname",
            run: async () => {
              setNicknames(previous);
              await backend.saveNicknames(previous);
            },
          });
          applied.push("cleared nickname");
          continue;
        }

        if (action.kind === "generateAvatar") {
          if (action.authorId && !users.some((u) => u.id === action.authorId)) {
            notes.push("couldn't identify which person you meant");
            continue;
          }
          const result = await backend.generateAvatar(action.prompt, action.authorId);
          if (result.ok && result.url) {
            // No undo for this one, unlike everything else here — restoring
            // a PRIOR avatar_url via a direct client write would reintroduce
            // exactly the "client can set an arbitrary avatar_url" risk
            // api/avatar.js exists to close (see that file). The user can
            // always just ask to change it again.
            setUsers(await backend.getUsers());
            const targetName =
              action.authorId && action.authorId !== backend.viewerId
                ? (users.find((u) => u.id === action.authorId)?.name ?? "their")
                : "your";
            applied.push(`generated ${targetName === "your" ? "your" : `${targetName}'s`} new avatar`);
          } else {
            notes.push(`couldn't generate avatar (${result.error})`);
          }
          continue;
        }

        if (action.kind === "filterByAuthor") {
          // Not implemented yet — no UI state consumes this. Report honestly
          // rather than claiming success for something that visibly does
          // nothing (violates the "no silent failures" principle elsewhere
          // in this file).
          notes.push("filtering the view by author isn't available yet");
          continue;
        }
      }

      await refresh();

      if (applied.length > 0) {
        // Collapse this turn's inverses into one undo step.
        pushUndo({
          label: "step",
          run: async () => {
            for (const inv of [...inverses].reverse()) await inv.run();
          },
        });
        logResult(trimmed, plan.reply || applied.join(", "), true);
        setNotice(notes.length ? notes.join("; ") : null);
      } else if (notes.length === 0 && plan.feasible && plan.reply) {
        // Nothing was applied, nothing failed, and the router marked this
        // feasible with an answer — a genuine conversational turn ("why does
        // it look like that", "what other colors could work"), not a failed
        // instruction. Must not read as an error in the UI or count toward
        // "I couldn't do that" framing.
        logResult(trimmed, plan.reply, false, "conversational");
        setNotice(null);
      } else {
        const summary = plan.reply || notes.join("; ") || "I couldn't do that one.";
        logResult(trimmed, summary, false, "failed");
        setNotice(summary);
      }
      setInstruction("");
    } catch (err) {
      const msg = errorMessage(err);
      logResult(text.trim(), msg, false);
      setNotice(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen w-full flex-col gap-6 bg-neutral-100 p-6 lg:flex-row">
      <div className="flex w-full flex-col gap-4 lg:w-[32rem]">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Piper</h1>
          <p className="mt-1 text-sm text-black/60">For Test Use</p>
        </div>

        {headerSlot}

        {onSwitchViewer ? (
          <div className="flex items-center gap-2 rounded-full bg-black/5 p-1 text-sm">
            {users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onSwitchViewer(u.id)}
                className={`flex-1 rounded-full px-3 py-1.5 transition ${
                  backend.viewerId === u.id
                    ? "bg-white shadow font-medium"
                    : "text-black/50 hover:text-black/80"
                }`}
              >
                Viewing as {u.name}
              </button>
            ))}
          </div>
        ) : null}

        {/* One window, like a real chat with Piper: header, scrollable
            thread, contextual panels, composer — all inside a single
            bordered container instead of a form floating separately above
            an unrelated-looking log box. */}
        {/* Fixed height, not flex-1/min-h — flex-1 let this grow to fill
            whatever vertical space the column had, which on a normal
            viewport made it taller than the Sam-chat panel's fixed 640px and
            pushed the composer below the fold while trying to also show the
            whole other chat. A fixed height shorter than 640px keeps both
            panels visible together without scrolling. */}
        <div className="flex h-[480px] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white">
          <div className="flex shrink-0 items-center justify-between border-b border-black/10 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-black/40">Chat with Piper</div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void runInstruction("reset to default")}
                disabled={busy}
                className="rounded-full border border-black/10 px-2 py-0.5 text-xs text-black/60 hover:border-black/25 disabled:opacity-30"
              >
                ↺ Reset to default
              </button>
              <button
                type="button"
                onClick={() => void undo()}
                disabled={undoStack.length === 0}
                className="rounded-full border border-black/10 px-2 py-0.5 text-xs text-black/60 hover:border-black/25 disabled:opacity-30"
              >
                ↶ Undo
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {log.length === 0 ? (
              <div className="text-sm text-black/40">No changes yet — try an instruction, or ask a question.</div>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {log.map((entry, i) => {
                  const style: Record<LogEntry["kind"], { bubble: string; icon: string }> = {
                    applied: { bubble: "bg-green-50 text-green-900", icon: "✓" },
                    clarifying: { bubble: "bg-sky-50 text-sky-900", icon: "❓" },
                    conversational: { bubble: "bg-black/[0.04] text-black/80", icon: "💬" },
                    failed: { bubble: "bg-amber-50 text-amber-900", icon: "⚠" },
                  };
                  const { bubble, icon } = style[entry.kind];
                  return (
                    <li key={i} className="flex flex-col gap-1">
                      {/* Your turn — styled like an outgoing bubble, right-aligned */}
                      <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-black px-3 py-1.5 text-sm text-white">
                        {entry.instruction}
                      </div>
                      {/* Piper's turn — colored by outcome, left-aligned */}
                      <div className={`self-start flex max-w-[85%] items-start gap-1.5 rounded-2xl rounded-bl-sm px-3 py-1.5 text-sm ${bubble}`}>
                        <span className="mt-0.5 shrink-0">{icon}</span>
                        <span>{entry.summary}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div ref={logEndRef} />
          </div>

          {pendingClarification ? (
            // The question itself is already visible as the last bubble in
            // the thread above — this is just the "still waiting on you"
            // affordance plus a way out if you'd rather ask something else.
            <div className="flex shrink-0 items-center gap-2 border-t border-black/10 px-3 py-1.5 text-xs text-sky-700">
              <span>❓ Waiting for your answer</span>
              <button type="button" onClick={() => setPendingClarification(null)} className="underline hover:text-sky-900">
                Cancel
              </button>
            </div>
          ) : notice ? (
            <div className="flex shrink-0 items-start gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span className="mt-0.5">⚠</span>
              <span className="flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="text-amber-500 hover:text-amber-700"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          ) : null}

          {queryResult ? (
            <div className="flex shrink-0 flex-col gap-2 border-t border-blue-100 bg-blue-50 px-3 py-2">
              {queryResult.type === "summary" && (
                <div>
                  <div className="text-xs font-medium text-blue-700 mb-1">Summary</div>
                  <div className="text-sm text-blue-900">{queryResult.content}</div>
                  <button
                    type="button"
                    onClick={() => setQueryResult(null)}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-800"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {queryResult.type === "reply" && (
                <div>
                  <div className="text-xs font-medium text-blue-700 mb-1">Draft Reply</div>
                  <div className="text-sm text-blue-900 mb-2">{queryResult.content}</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setInstruction(queryResult.content as string);
                        setQueryResult(null);
                      }}
                      className="text-xs rounded px-2 py-1 bg-blue-200 text-blue-900 hover:bg-blue-300"
                    >
                      Use this
                    </button>
                    <button
                      type="button"
                      onClick={() => setQueryResult(null)}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {(queryResult.type === "roast" || queryResult.type === "compliment") && (
                <div>
                  <div className="text-xs font-medium text-blue-700 mb-1">
                    {queryResult.type === "roast" ? "🔥 Roast" : "💛 Compliment"}
                  </div>
                  <div className="text-sm text-blue-900">{queryResult.content}</div>
                  <button
                    type="button"
                    onClick={() => setQueryResult(null)}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-800"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {queryResult.type === "suggestions" && (
                <div>
                  <div className="text-xs font-medium text-blue-700 mb-2">Suggested Replies</div>
                  <div className="flex flex-col gap-2">
                    {(queryResult.content as string[]).map((reply, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          void handleSend(reply);
                          setQueryResult(null);
                        }}
                        className="text-left text-sm rounded px-2 py-1.5 bg-white border border-blue-200 text-blue-900 hover:bg-blue-100 transition"
                      >
                        {reply}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setQueryResult(null)}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-800"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ) : null}

          <form
            className="flex shrink-0 items-center gap-2 border-t border-black/10 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void runInstruction(instruction);
            }}
          >
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={pendingClarification ? "Answer the question above…" : "Tell Piper what to do…"}
              className={`flex-1 rounded-full border bg-white px-4 py-2 text-sm outline-none focus:border-black/30 ${
                pendingClarification ? "border-sky-300" : "border-black/15"
              }`}
            />
            <button
              type="submit"
              disabled={busy || !instruction.trim()}
              className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : "Send"}
            </button>
          </form>
        </div>
      </div>

      <div className="flex flex-1 items-start justify-center">
        <div className="w-full max-w-md">
          <Chat
            spec={composedSpec}
            messages={messages}
            viewerId={backend.viewerId}
            users={users}
            nicknames={nicknames}
            typingUserId={typingUserId}
            onTypingChange={handleTypingChange}
            translations={translations}
            pinnedMessageIds={pinnedMessageIds}
            starredMessageIds={starredMessageIds}
            onSend={(t) => void handleSend(t)}
            onTranslate={(id, target) => void handleTranslate(id, target)}
            onRemoveCustomComponent={(id) => void removeCustomComponent(id)}
            sharedState={sharedState}
            onSetSharedState={(id, next) => void handleSetSharedState(id, next)}
            onAppendSharedState={(id, key, item) => void handleAppendSharedState(id, key, item)}
          />
        </div>
      </div>
    </div>
  );
}
