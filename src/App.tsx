import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Workspace } from "./Workspace";
import { SignIn } from "./components/SignIn";
import { createLocalBackend, createSupabaseBackend } from "./lib/backend";
import { getOrCreateConversation, joinByInviteCode, signOut } from "./lib/db";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import type { Conversation } from "./lib/types";

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
  const [conversation, setConversation] = useState<Conversation | null>(null);
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

  // Once signed in: honour an invite code, else open (or create) a conversation.
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
        const conv = await getOrCreateConversation(session.user.id);
        console.log("[auth] got conversation:", conv.id);
        if (alive) setConversation(conv);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as any).message)
              : String(err);
        console.error("Failed to join or create conversation:", err);
        if (alive) setError(msg || "Something went wrong (no message)");
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, inviteCode]);

  if (!ready) return <Centered>Loading…</Centered>;
  if (!session) return <SignIn inviteCode={inviteCode} />;
  if (error) return <Centered>Something went wrong: {error}</Centered>;
  if (!conversation) return <Centered>Opening your chat…</Centered>;

  return (
    <MultiplayerWorkspace
      conversationId={conversation.id}
      inviteCode={conversation.invite_code}
      userId={session.user.id}
      email={session.user.email ?? ""}
    />
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
  const inviteUrl = `${window.location.origin}/join/${inviteCode}`;

  return (
    <Workspace
      backend={backend}
      headerSlot={
        <div className="flex flex-col gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-black/60">Signed in as {email}</span>
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
          <div className="mt-1 break-all rounded bg-black/5 px-2 py-1 text-xs text-black/70">
            {inviteUrl}
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
