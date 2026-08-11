import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Workspace } from "./Workspace";
import { SignIn } from "./components/SignIn";
import { createLocalBackend, createSupabaseBackend } from "./lib/backend";
import {
  createConversation,
  joinByInviteCode,
  leaveConversation,
  listMyConversations,
  signOut,
  type ConversationSummary,
} from "./lib/db";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import { getBuildInfo, type BuildInfo } from "./lib/build-info";
import { errorMessage } from "./lib/errors";

/** Which conversation you were last looking at, so a reload doesn't dump you
 *  back on whichever one happens to be "most recent" — session-only in the
 *  sense that it's just localStorage, no server-side concept of "current"
 *  conversation exists (you're a member of all of them equally). */
const ACTIVE_CONVERSATION_KEY = "piper_active_conversation";

/** `?invite=<code>` (or `/join/<code>`) lets a friend join your conversation.
 *  The magic link redirect loses the query string, so we store it in localStorage. */
function readInviteCode(): string | null {
  console.log("[invite-debug] full URL:", window.location.href);
  console.log("[invite-debug] search string:", window.location.search);
  console.log("[invite-debug] localStorage contents:", {
    piper_invite_code: localStorage.getItem("piper_invite_code"),
    all: Object.keys(localStorage),
  });

  // First check if we have it stored from before the auth redirect
  const stored = localStorage.getItem("piper_invite_code");
  if (stored) {
    console.log("[invite] ✓ found code in localStorage:", stored);
    localStorage.removeItem("piper_invite_code"); // one-time use
    return stored;
  }

  // Check the URL (query string or path)
  const params = new URLSearchParams(window.location.search);
  console.log("[invite-debug] parsed params:", params.toString());
  const fromQuery = params.get("invite");
  if (fromQuery) {
    console.log("[invite] ✓ found code in query:", fromQuery);
    localStorage.setItem("piper_invite_code", fromQuery);
    console.log("[invite-debug] stored in localStorage, verify:", localStorage.getItem("piper_invite_code"));
    return fromQuery;
  }
  const match = window.location.pathname.match(/^\/join\/([A-Za-z0-9]+)$/);
  if (match) {
    console.log("[invite] ✓ found code in path:", match[1]);
    localStorage.setItem("piper_invite_code", match[1]);
    return match[1];
  }
  console.log("[invite] ✗ no code in URL or storage");
  return null;
}

export default function App() {
  // Without Supabase credentials the app still runs as the original
  // single-player demo, so local development never hard-blocks on config.
  if (!isSupabaseConfigured) return <LocalDemo />;
  return <Multiplayer />;
}

// ---------------------------------------------------------------------------
// Local demo (no accounts) — the original two-fake-users experience.
// ---------------------------------------------------------------------------

function LocalDemo() {
  const [viewerId, setViewerId] = useState("you");
  const backend = useMemo(() => createLocalBackend(viewerId), [viewerId]);
  return (
    <Workspace
      backend={backend}
      onSwitchViewer={setViewerId}
      headerSlot={
        <div className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-black/50">
          Demo mode — no accounts, messages live in this tab only. Add
          <code className="mx-1 rounded bg-black/5 px-1">VITE_SUPABASE_URL</code>
          and
          <code className="mx-1 rounded bg-black/5 px-1">VITE_SUPABASE_ANON_KEY</code>
          to go multiplayer.
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Multiplayer
// ---------------------------------------------------------------------------

function Multiplayer() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Call directly instead of useMemo so it re-runs after auth redirects change the URL
  const inviteCode = readInviteCode();

  useEffect(() => {
    const sb = supabase!;
    void sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Once signed in: honour an invite code (joins whatever specific
  // conversation that code points at — unaffected by any of this), then load
  // every conversation the user belongs to.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    void (async () => {
      try {
        if (inviteCode) {
          console.log("[auth] joining via invite code:", inviteCode);
          await joinByInviteCode(inviteCode);
          console.log("[auth] successfully joined conversation");
          // Clear the code from the URL so a refresh doesn't re-join.
          window.history.replaceState({}, "", window.location.origin);
        } else {
          console.log("[auth] no invite code in URL");
        }
        let list = await listMyConversations(session.user.id);
        if (list.length === 0) {
          console.log("[auth] no conversations yet, creating first one");
          const created = await createConversation(session.user.id);
          list = [{ ...created, otherName: null }];
        }
        if (!alive) return;
        setConversations(list);
        // Land back on whichever conversation you were last viewing, if it's
        // still one of yours (e.g. an invite-code join just now added a new
        // one, which shouldn't silently steal focus from wherever you were).
        const stored = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
        setActiveId(stored && list.some((c) => c.id === stored) ? stored : list[0].id);
      } catch (err) {
        console.error("Failed to join/list conversations:", err);
        if (alive) setError(errorMessage(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, inviteCode]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeId);
  }, [activeId]);

  async function startNewConversation() {
    if (!session) return;
    const created = await createConversation(session.user.id);
    const summary: ConversationSummary = { ...created, otherName: null };
    setConversations((prev) => [summary, ...prev]);
    setActiveId(created.id);
  }

  // "X" on a tab — leaves that conversation (see leaveConversation: only
  // your own membership is removed, never the conversation or its messages,
  // so the other participant is completely unaffected). Never leaves you
  // with zero tabs: closing the last one immediately creates a fresh empty
  // one, matching the same invariant the initial sign-in bootstrap keeps.
  async function closeConversation(id: string) {
    if (!session) return;
    await leaveConversation(id, session.user.id);
    const remaining = conversations.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const created = await createConversation(session.user.id);
      const summary: ConversationSummary = { ...created, otherName: null };
      setConversations([summary]);
      setActiveId(created.id);
      return;
    }
    setConversations(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  }

  if (!ready) return <Centered>Loading…</Centered>;
  if (!session) return <SignIn inviteCode={inviteCode} />;
  if (error) return <Centered>Something went wrong: {error}</Centered>;
  if (conversations.length === 0 || !activeId) return <Centered>Opening your chat…</Centered>;

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];

  return (
    // Not min-h-screen here — Workspace's own root div already is, and
    // stacking two would make the page taller than one viewport for no
    // reason (tab-bar height on top of a full 100vh workspace below it).
    // pt-3 + the tab bar's own bigger padding: reported as feeling "hidden"
    // flush against the very top edge of the browser (easy to mistake for
    // browser chrome) — this gives it some breathing room and visual weight
    // instead of reading as an incidental thin sliver.
    <div className="flex flex-col bg-neutral-100 px-4 pt-3">
      <ConversationTabs
        conversations={conversations}
        activeId={active.id}
        onSelect={setActiveId}
        onNew={() => void startNewConversation()}
        onClose={(id) => void closeConversation(id)}
      />
      {/* key forces a full remount on switch — Workspace holds a lot of its
          own state (messages, spec, undo stack, log) that should start fresh
          for a different conversation, not gradually reconcile onto it. */}
      <MultiplayerWorkspace
        key={active.id}
        conversationId={active.id}
        inviteCode={active.invite_code}
        userId={session.user.id}
        email={session.user.email ?? ""}
      />
    </div>
  );
}

function ConversationTabs({
  conversations,
  activeId,
  onSelect,
  onNew,
  onClose,
}: {
  conversations: ConversationSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}) {
  return (
    // "+ New chat" is OUTSIDE the scrolling region on purpose — it used to
    // be just another item in the same overflow-x-auto row as the tabs,
    // which meant a long conversation name (or enough tabs) could push it
    // past the visible edge with no visual hint that there was more to
    // scroll to. Pinning it as its own flex item guarantees it's always
    // visible regardless of how many tabs there are or how wide they are.
    // py-3 + text-sm (up from py-2/text-xs): reported as feeling too small/
    // easy to miss at the default size.
    <div className="flex items-center gap-2 rounded-2xl border border-black/10 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-1 items-center gap-2 overflow-x-auto">
        {conversations.map((c) => {
          // A custom title (via "rename this conversation") wins over the
          // other person's name; otherwise show who's actually in it, or a
          // clear "nobody's joined this link yet" state rather than a blank tab.
          const label = c.title !== "New chat" ? c.title : (c.otherName ?? "New chat (no one's joined yet)");
          const isActive = c.id === activeId;
          return (
            // A <button> can't nest another <button> (the X), so the pill is
            // a div with two button children instead of one button — select
            // on the label, close on the X, and the X stops propagation so
            // clicking it can't also select the tab you're about to leave.
            <div
              key={c.id}
              className={`flex shrink-0 items-center gap-1 rounded-full border py-1 pl-3 pr-1.5 text-sm transition ${
                isActive ? "border-black bg-black text-white font-medium" : "border-black/10 text-black/60 hover:border-black/25"
              }`}
            >
              <button type="button" onClick={() => onSelect(c.id)}>
                {label}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(c.id);
                }}
                aria-label={`Close ${label}`}
                className={`rounded-full px-1 leading-none ${
                  isActive ? "text-white/60 hover:text-white" : "text-black/30 hover:text-black/60"
                }`}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNew}
        className="shrink-0 rounded-full bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-black/80"
      >
        + New chat
      </button>
    </div>
  );
}

function MultiplayerWorkspace({
  conversationId,
  inviteCode,
  userId,
  email,
}: {
  conversationId: string;
  inviteCode: string;
  userId: string;
  email: string;
}) {
  const backend = useMemo(() => {
    console.log("[backend] creating Supabase backend for conversation:", conversationId, "user:", userId);
    return createSupabaseBackend(conversationId, userId);
  }, [conversationId, userId]);
  const [copied, setCopied] = useState(false);
  const [otherUser, setOtherUser] = useState<{ id: string; name: string } | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const inviteUrl = `${window.location.origin}/join/${inviteCode}`;

  // Fetch conversation members to display the other person's name
  useEffect(() => {
    void (async () => {
      try {
        const users = await backend.getUsers();
        const other = users.find((u) => u.id !== userId);
        if (other) {
          setOtherUser({ id: other.id, name: other.name });
        }
      } catch (err) {
        console.error("Failed to fetch users:", err);
      }
    })();
  }, [backend, userId]);

  // Load build info
  useEffect(() => {
    void (async () => {
      const info = await getBuildInfo();
      setBuildInfo(info);
    })();
  }, []);

  return (
    <Workspace
      backend={backend}
      headerSlot={
        <div className="flex flex-col gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-black/60 flex-1">
              {otherUser ? (
                <>
                  <span className="font-medium">{otherUser.name}</span>
                  <span className="mx-1">↔</span>
                  <span className="font-medium">You</span>
                  <span className="mx-1 block text-black/40">({email})</span>
                </>
              ) : (
                <span>Signed in as {email}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="shrink-0 text-black/40 underline hover:text-black/70"
            >
              Sign out
            </button>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(inviteUrl);
              } catch {
                /* clipboard may be blocked; the link is still shown below */
              }
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            className="rounded-full border border-black/10 px-2 py-1 text-black/70 hover:border-black/25"
          >
            {copied ? "✓ invite link copied" : "Copy invite link for a friend"}
          </button>
          <div className="rounded bg-black/5 px-2 py-1 text-xs text-black/40 overflow-hidden max-h-0 opacity-0" title="Invite link (hidden, copy via button)">
            {inviteUrl}
          </div>
          <div className="text-xs text-black/50 border-t border-black/5 pt-2">
            <div className="font-medium text-black/60">Last Deploy</div>
            <div>{buildInfo?.date ?? "Loading..."}</div>
          </div>
        </div>
      }
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-6 text-sm text-black/60">
      {children}
    </div>
  );
}
