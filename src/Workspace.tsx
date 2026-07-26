import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import type { TranslationEntry } from "./components/slots";
import { generateSpec, keywordOnly } from "./engine/generate";
import { routeInstruction } from "./engine/route";
import { translateText } from "./engine/translate";
import { DEFAULT_SPEC, type Spec } from "./engine/spec";
import type { ChatBackend, DisplayUser } from "./lib/backend";
import type { ChatMessage } from "./lib/types";

const EXAMPLE_CHIPS = [
  "make my bubbles green with tails",
  "blue to purple gradient background",
  "translate the last message to Japanese",
  "react to the last message with 🔥",
  "delete my last message",
  "delete all reactions on the last message",
  "delete all of Sam's messages",
  "star the one that says grab dinner",
  "summarize this conversation",
  "randomize my theme",
  "reset theme",
];

interface LogEntry {
  instruction: string;
  summary: string;
  matched: boolean;
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
  const [spec, setSpec] = useState<Spec>(DEFAULT_SPEC);
  const [translations, setTranslations] = useState<Record<string, TranslationEntry>>({});
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    console.log("[refresh] fetching messages...");
    const msgs = await backend.fetchMessages();
    console.log("[refresh] got", msgs.length, "messages:", msgs);
    setMessages(msgs);
  }, [backend]);

  // Initial load + realtime subscription.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [nextUsers, nextMessages, nextSpec] = await Promise.all([
        backend.getUsers(),
        backend.fetchMessages(),
        backend.loadTheme(),
      ]);
      if (!alive) return;
      setUsers(nextUsers);
      setMessages(nextMessages);
      setSpec(nextSpec);
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

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(t);
  }, [notice]);

  const pushUndo = (op: UndoOp) => setUndoStack((prev) => [...prev, op]);

  async function undo() {
    const op = undoStack[undoStack.length - 1];
    if (!op) return;
    setUndoStack((prev) => prev.slice(0, -1));
    await op.run();
    await refresh();
    setNotice(null);
  }

  async function applyTheme(next: Spec, previous: Spec) {
    setSpec(next);
    await backend.saveTheme(next);
    pushUndo({
      label: "theme",
      run: async () => {
        setSpec(previous);
        await backend.saveTheme(previous);
      },
    });
  }

  async function handleSend(text: string) {
    await backend.send(text);
    await refresh();
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

  const logResult = (instructionText: string, summary: string, matched: boolean) =>
    setLog((prev) => [...prev, { instruction: instructionText, summary, matched }]);

  async function runInstruction(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      // 1. Free keyword fast-path (personal theme only).
      const kw = keywordOnly(trimmed, spec);
      if (kw) {
        await applyTheme(kw.spec, spec);
        logResult(trimmed, kw.summary, true);
        setNotice(null);
        setInstruction("");
        return;
      }

      // 2. Router.
      const routed = await routeInstruction(trimmed, messages, users, backend.viewerId);

      if (routed.status === "unavailable") {
        const r = await generateSpec(trimmed, spec);
        if (r.matched) {
          await applyTheme(r.spec, spec);
          logResult(trimmed, r.summary, true);
          setNotice(null);
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

      // 3. Execute the plan.
      const plan = routed.plan;
      const applied: string[] = [];
      const notes: string[] = [];
      const inverses: UndoOp[] = [];

      // Handle theme mutations (reset, randomize)
      if (plan.themeMutation === "reset") {
        const previous = spec;
        setSpec(DEFAULT_SPEC);
        await backend.saveTheme(DEFAULT_SPEC);
        inverses.push({
          label: "theme",
          run: async () => {
            setSpec(previous);
            await backend.saveTheme(previous);
          },
        });
        applied.push("reset theme");
      } else if (plan.themeMutation === "randomize") {
        // Generate a random spec by picking random values from the registry
        const r = await generateSpec("random colorful fun theme", spec);
        if (r.matched) {
          const previous = spec;
          setSpec(r.spec);
          await backend.saveTheme(r.spec);
          inverses.push({
            label: "theme",
            run: async () => {
              setSpec(previous);
              await backend.saveTheme(previous);
            },
          });
          applied.push("randomized theme");
        }
      }

      // Handle theme instruction (appearance request)
      if (plan.themeInstruction) {
        const r = await generateSpec(plan.themeInstruction, spec);
        if (r.matched) {
          const previous = spec;
          setSpec(r.spec);
          await backend.saveTheme(r.spec);
          inverses.push({
            label: "theme",
            run: async () => {
              setSpec(previous);
              await backend.saveTheme(previous);
            },
          });
          applied.push(r.summary);
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
            case "deleteReaction":
              // For now, toggle the reaction (which acts like delete if it exists)
              await backend.react(action.messageId, action.emoji);
              inverses.push({
                label: "deleteReaction",
                run: () => backend.react(action.messageId, action.emoji),
              });
              applied.push(`removed ${action.emoji}`);
              break;
            case "deleteAllReactions":
              // Placeholder: would need backend support
              notes.push("clearing reactions (needs backend implementation)");
              break;
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
              // Placeholder: needs backend/DB support
              applied.push(`pinned "${message.text.slice(0, 20)}..."`);
              break;
            case "unpinMessage":
              // Placeholder: needs backend/DB support
              applied.push("unpinned");
              break;
            case "starMessage":
              // Placeholder: needs backend/DB support
              applied.push("starred");
              break;
            case "unstarMessage":
              // Placeholder: needs backend/DB support
              applied.push("unstarred");
              break;
          }
        }

        // Actions that don't require a messageId
        if (action.kind === "deleteAllMessagesBy") {
          const authorId = action.authorId;
          const count = messages.filter((m) => m.authorId === authorId).length;
          await backend.react("dummy", "dummy"); // Placeholder to trigger refresh
          applied.push(`deleted ${count} messages from that person`);
          break;
        }

        if (action.kind === "summarizeConversation") {
          // Placeholder for now - would call /api/summarize
          applied.push("generated summary (API coming soon)");
          break;
        }

        if (action.kind === "generateResponse") {
          // Placeholder - would call /api/generate-response
          applied.push("generated reply (API coming soon)");
          break;
        }

        if (action.kind === "suggestReplies") {
          // Placeholder - would call /api/suggest-replies
          applied.push("suggested 3 replies (API coming soon)");
          break;
        }

        if (action.kind === "filterByAuthor") {
          // Filter is handled in UI state (would need a new Workspace state field)
          if (action.authorId) {
            applied.push("filtering by author");
          } else {
            applied.push("cleared author filter");
          }
          break;
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
      } else {
        const summary = plan.reply || notes.join("; ") || "I couldn't do that one.";
        logResult(trimmed, summary, false);
        setNotice(summary);
      }
      setInstruction("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logResult(text.trim(), msg, false);
      setNotice(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen w-full flex-col gap-6 bg-neutral-100 p-6 lg:flex-row">
      <div className="flex w-full flex-col gap-4 lg:w-[26rem]">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Piper</h1>
          <p className="mt-1 text-sm text-black/60">
            Restyle your own view, or act on the conversation — translate, edit, delete, react.
            Appearance changes are private to you; messages, reactions and polls are shared.
          </p>
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

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runInstruction(instruction);
          }}
        >
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Tell Piper what to do…"
            className="flex-1 rounded-full border border-black/15 bg-white px-4 py-2 text-sm outline-none focus:border-black/30"
          />
          <button
            type="submit"
            disabled={busy || !instruction.trim()}
            className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>

        {notice ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
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

        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={busy}
              onClick={() => void runInstruction(chip)}
              className="rounded-full border border-black/10 bg-white px-2.5 py-1 text-xs text-black/60 hover:border-black/25 disabled:opacity-40"
            >
              {chip}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto rounded-2xl border border-black/10 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-black/40">
              Change log
            </div>
            <button
              type="button"
              onClick={() => void undo()}
              disabled={undoStack.length === 0}
              className="rounded-full border border-black/10 px-2 py-0.5 text-xs text-black/60 hover:border-black/25 disabled:opacity-30"
            >
              ↶ Undo
            </button>
          </div>
          {log.length === 0 ? (
            <div className="text-sm text-black/40">
              No changes yet — try an instruction or an example.
            </div>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {log.map((entry, i) => (
                <li key={i}>
                  <div className="text-black/70">{entry.instruction}</div>
                  <div className={entry.matched ? "text-green-600" : "text-amber-600"}>
                    {entry.matched ? "✓" : "›"} {entry.summary}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      <div className="flex flex-1 items-start justify-center">
        <div className="w-full max-w-md">
          <Chat
            spec={spec}
            messages={messages}
            viewerId={backend.viewerId}
            users={users}
            translations={translations}
            onSend={(t) => void handleSend(t)}
            onTranslate={(id, target) => void handleTranslate(id, target)}
          />
        </div>
      </div>
    </div>
  );
}
