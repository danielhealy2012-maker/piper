import { useState } from "react";
import { sendMagicLink } from "../lib/db";

export function SignIn({ inviteCode }: { inviteCode: string | null }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await sendMagicLink(email.trim());
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(result.error ?? "Couldn't send the link");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Piper</h1>
        <p className="mt-1 text-sm text-black/60">
          {inviteCode
            ? "You've been invited to a chat. Sign in to join it."
            : "A chat you reshape by talking to it. Sign in to get started."}
        </p>

        {sent ? (
          <div className="mt-5 rounded-xl border border-green-300 bg-green-50 px-3 py-3 text-sm text-green-800">
            Check <span className="font-medium">{email}</span> for a sign-in link. Open it on this
            device and you'll land straight in the chat.
          </div>
        ) : (
          <form className="mt-5 flex flex-col gap-2" onSubmit={submit}>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-full border border-black/15 px-4 py-2 text-sm outline-none focus:border-black/30"
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
          </form>
        )}

        <p className="mt-4 text-xs text-black/40">
          No password. We email you a one-time link that signs you in.
        </p>
      </div>
    </div>
  );
}
