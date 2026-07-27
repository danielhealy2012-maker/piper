import { useState, type ReactNode } from "react";
import type { Action } from "../engine/spec";
import type { ChatMessage } from "../lib/types";

// This lookup table is the ONLY place a validated spec action becomes DOM.
// A fixed switch over action.component; anything unknown renders nothing.

export type TranslationEntry =
  | { status: "loading" }
  | { status: "shown"; text: string }
  | { status: "error"; error: string };

export interface SlotContext {
  message?: ChatMessage;
  outgoing?: boolean;
  draft: string;
  setDraft: (next: string) => void;
  // Translation lives in Chat, not here, because it replaces the BUBBLE text —
  // a slot component can't reach up and rewrite the message it hangs beneath.
  translation?: TranslationEntry;
  onTranslate?: (target: string) => void;
}

// A translucent white pill (not black) so these stay legible on any wallpaper,
// including dark/custom-dark backgrounds, without threading theme state through
// every one of the ~15 components below.
function btnClass(extra = "") {
  return `inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[11px] text-black/70 shadow-sm backdrop-blur-sm hover:bg-white transition ${extra}`;
}

function TranslateButton({
  props,
  translation,
  onTranslate,
}: {
  props: { target: string };
  translation?: TranslationEntry;
  onTranslate?: (target: string) => void;
}) {
  const status = translation?.status ?? "idle";
  const label =
    status === "loading"
      ? "translating…"
      : status === "shown"
        ? "show original"
        : status === "error"
          ? "retry"
          : "translate";

  return (
    <button
      className={btnClass(status === "error" ? "text-red-600" : "")}
      onClick={() => onTranslate?.(props.target)}
      disabled={status === "loading"}
      type="button"
    >
      🌐 {label}
      {translation?.status === "error" ? (
        <span className="ml-1">({translation.error})</span>
      ) : null}
    </button>
  );
}

function SummarizeButton({ message }: { message?: ChatMessage }) {
  const [shown, setShown] = useState(false);
  const gist = message ? `${message.text.slice(0, 18)}…` : "";
  return (
    <button className={btnClass()} onClick={() => setShown((s) => !s)} type="button">
      📝 {shown ? gist : "summarize"}
    </button>
  );
}

function CopyButton({ message }: { message?: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={btnClass()}
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(message?.text ?? "");
        } catch {
          // clipboard may be unavailable (permissions, insecure context) — demo still flashes
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "✓ copied" : "⧉ copy"}
    </button>
  );
}

function PinButton() {
  const [pinned, setPinned] = useState(false);
  return (
    <button className={btnClass(pinned ? "bg-amber-100 text-amber-700" : "")} type="button" onClick={() => setPinned((p) => !p)}>
      📌 {pinned ? "pinned" : "pin"}
    </button>
  );
}

function ReactionBar({ props }: { props: { emojis: string[] } }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1">
      {props.emojis.map((e) => (
        <button
          key={e}
          type="button"
          className={`rounded-full px-1 text-xs hover:scale-110 transition ${picked === e ? "bg-black/10" : ""}`}
          onClick={() => setPicked((p) => (p === e ? null : e))}
        >
          {e}
        </button>
      ))}
    </span>
  );
}

function ReadReceipt() {
  return <span className={btnClass("text-black/50")}>✓✓ Read</span>;
}

function ToneShifter({ props, draft, setDraft }: { props: { tones: string[] }; draft: string; setDraft: (v: string) => void }) {
  return (
    <span className="flex flex-wrap gap-1">
      {props.tones.map((tone) => (
        <button
          key={tone}
          type="button"
          className={btnClass()}
          onClick={() => setDraft(draft ? `[${tone}] ${draft}` : `[${tone}] `)}
        >
          {tone}
        </button>
      ))}
    </span>
  );
}

function ClearButton({ setDraft }: { setDraft: (v: string) => void }) {
  return (
    <button type="button" className={btnClass()} onClick={() => setDraft("")}>
      ✕ clear
    </button>
  );
}

function VoiceNote() {
  const [recording, setRecording] = useState(false);
  return (
    <button type="button" className={btnClass(recording ? "bg-red-100 text-red-600" : "")} onClick={() => setRecording((r) => !r)}>
      {recording ? "▂▄▆▄▂ recording…" : "🎙️ voice note"}
    </button>
  );
}

function GifPicker({ setDraft, draft }: { setDraft: (v: string) => void; draft: string }) {
  return (
    <button type="button" className={btnClass()} onClick={() => setDraft(`${draft}[gif 🐱]`)}>
      🖼️ gif
    </button>
  );
}

function Poll({ props }: { props: { question: string; options: string[] } }) {
  const [vote, setVote] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-black/10 bg-white/70 px-2 py-1 text-xs">
      <div className="font-medium">{props.question}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {props.options.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`rounded-full px-2 py-0.5 ${vote === opt ? "bg-black/80 text-white" : "bg-black/5"}`}
            onClick={() => setVote(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScheduledSend() {
  return <span className={btnClass()}>🕒 will send tomorrow 9:00 AM</span>;
}

function AIReplyDraft({ setDraft }: { setDraft: (v: string) => void }) {
  return (
    <button type="button" className={btnClass()} onClick={() => setDraft("Sounds great, let's do it!")}>
      ✨ AI draft
    </button>
  );
}

function SearchBox() {
  const [value, setValue] = useState("");
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search"
      className="w-24 rounded-full border border-black/10 bg-white/70 px-2 py-0.5 text-xs outline-none"
    />
  );
}

function MuteToggle() {
  const [muted, setMuted] = useState(false);
  return (
    <button type="button" className={btnClass(muted ? "bg-black/10" : "")} onClick={() => setMuted((m) => !m)}>
      {muted ? "🔕" : "🔔"}
    </button>
  );
}

function ThemeBadge({ props }: { props: { text: string } }) {
  return <span className={btnClass()}>🎨 {props.text}</span>;
}

function VideoCallButton() {
  return (
    <button type="button" className={btnClass()}>
      📹
    </button>
  );
}

export function renderAction(action: Action, index: number, ctx: SlotContext): ReactNode {
  const props = (action.props ?? {}) as Record<string, unknown>;
  const key = `${action.component}-${index}`;
  switch (action.component) {
    case "TranslateButton":
      return (
        <TranslateButton
          key={key}
          props={props as { target: string }}
          translation={ctx.translation}
          onTranslate={ctx.onTranslate}
        />
      );
    case "SummarizeButton":
      return <SummarizeButton key={key} message={ctx.message} />;
    case "CopyButton":
      return <CopyButton key={key} message={ctx.message} />;
    case "PinButton":
      return <PinButton key={key} />;
    case "ReactionBar":
      return <ReactionBar key={key} props={props as { emojis: string[] }} />;
    case "ReadReceipt":
      return ctx.outgoing ? <ReadReceipt key={key} /> : null;
    case "ToneShifter":
      return (
        <ToneShifter
          key={key}
          props={props as { tones: string[] }}
          draft={ctx.draft}
          setDraft={ctx.setDraft}
        />
      );
    case "ClearButton":
      return <ClearButton key={key} setDraft={ctx.setDraft} />;
    case "VoiceNote":
      return <VoiceNote key={key} />;
    case "GifPicker":
      return <GifPicker key={key} setDraft={ctx.setDraft} draft={ctx.draft} />;
    case "Poll":
      return <Poll key={key} props={props as { question: string; options: string[] }} />;
    case "ScheduledSend":
      return <ScheduledSend key={key} />;
    case "AIReplyDraft":
      return <AIReplyDraft key={key} setDraft={ctx.setDraft} />;
    case "SearchBox":
      return <SearchBox key={key} />;
    case "MuteToggle":
      return <MuteToggle key={key} />;
    case "ThemeBadge":
      return <ThemeBadge key={key} props={props as { text: string }} />;
    case "VideoCallButton":
      return <VideoCallButton key={key} />;
    default:
      return null;
  }
}
