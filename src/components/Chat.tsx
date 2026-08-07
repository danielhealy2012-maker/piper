import { useEffect, useRef, useState } from "react";
import { DEFAULT_SPEC, type Spec } from "../engine/spec";
import type { ChatMessage } from "../lib/types";
import type { DisplayUser } from "../lib/backend";
import { renderAction, type TranslationEntry } from "./slots";
import { bubbleStyle, fontStack, isDarkWallpaper, rowGap, sentimentColor, wallpaperStyle } from "./theme";
import { runEffect } from "./effects";
import { CustomComponentSlot } from "./CustomComponentSlot";

const SEND_ICONS: Record<Spec["theme"]["sendButtonStyle"], string> = {
  arrow: "↑",
  plane: "➤",
  heart: "♥",
  dot: "●",
};

export interface ChatProps {
  spec: Spec;
  messages: ChatMessage[];
  viewerId: string;
  users: DisplayUser[];
  // Translation state lives in App (so both the button and the action router can
  // drive it) and flows down here read-only.
  translations: Record<string, TranslationEntry>;
  pinnedMessageIds?: Set<string>;
  starredMessageIds?: Set<string>;
  onSend: (text: string) => void;
  onTranslate: (messageId: string, target: string) => void;
  onRemoveCustomComponent?: (id: string) => void;
  /** Live state for scope:"shared" components, keyed by component id, and the
   *  writer that propagates a change to the other person. */
  sharedState?: Record<string, unknown>;
  onSetSharedState?: (componentId: string, next: unknown) => void;
}

export function Chat({
  spec,
  messages,
  viewerId,
  users,
  translations,
  pinnedMessageIds,
  starredMessageIds,
  onSend,
  onTranslate,
  onRemoveCustomComponent,
  sharedState,
  onSetSharedState,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const theme = spec.theme;
  // `users` is empty on first render while the backend loads (and a brand-new
  // conversation legitimately has only you in it), so this must not assume a
  // second participant exists.
  const other = users.find((u) => u.id !== viewerId) ?? users[0] ?? null;
  const dark = isDarkWallpaper(theme);
  const headerTextClass = dark ? "text-white" : "text-black";
  const metaTextClass = dark ? "text-white/60" : "text-black/40";
  const headerBorderClass = dark ? "border-white/10" : "border-black/10";
  const bottomRef = useRef<HTMLDivElement>(null);
  const effectLayerRef = useRef<HTMLDivElement>(null);
  // Until the user renames the chat themselves, show whoever they're actually
  // talking to rather than the seed placeholder.
  const title =
    theme.chatTitle === DEFAULT_SPEC.theme.chatTitle && other?.name ? other.name : theme.chatTitle;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Ambient/persistent decorations (e.g. "a snake that continuously
  // slithers around") — unlike the message/reaction effects below, this
  // fires once when its code is set, not per-event, and the code is
  // expected to set up its own infinite CSS animation so it keeps running
  // without being re-triggered. Re-fires only when the onLoad code itself
  // changes (a new instruction replacing the ambient effect), not on every
  // unrelated re-render — clearing the layer first so the old ambient
  // effect doesn't linger alongside a new one.
  useEffect(() => {
    const code = spec.customEffects.onLoad;
    const container = effectLayerRef.current;
    if (!code || !container) return;
    container.innerHTML = "";
    runEffect(code, container);
  }, [spec.customEffects.onLoad]);

  const customComponentsFor = (slot: Spec["customComponents"][number]["slot"]) =>
    spec.customComponents
      .filter((c) => c.slot === slot)
      .map((c) => (
        <CustomComponentSlot
          key={c.id}
          spec={c}
          messages={messages}
          viewerId={viewerId}
          sendMessage={onSend}
          onRemove={(id) => onRemoveCustomComponent?.(id)}
          sharedState={sharedState?.[c.id]}
          onSetSharedState={onSetSharedState}
        />
      ));

  // Fire custom effects (model-generated JS) when a message shows up, keyed
  // off id so a refetch of the same messages doesn't re-trigger anything.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenReactionsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const seenIds = seenIdsRef.current;
    const seenReactions = seenReactionsRef.current;
    const isFirstRun = seenIds.size === 0;
    for (const message of messages) {
      if (!seenIds.has(message.id)) {
        seenIds.add(message.id);
        if (!isFirstRun) {
          const outgoing = message.authorId === viewerId;
          runEffect(
            outgoing ? spec.customEffects.onMessageSent : spec.customEffects.onMessageReceived,
            effectLayerRef.current,
          );
        }
      }
      const reactionCount = message.reactions?.length ?? 0;
      const prevCount = seenReactions.get(message.id) ?? 0;
      if (reactionCount > prevCount && !isFirstRun) {
        runEffect(spec.customEffects.onReaction, effectLayerRef.current);
      }
      seenReactions.set(message.id, reactionCount);
    }
  }, [messages, spec.customEffects, viewerId]);

  return (
    <div
      className="relative mx-auto flex h-[640px] w-full max-w-md flex-col overflow-hidden rounded-[28px] border border-black/10 bg-white shadow-xl"
      style={{ fontFamily: fontStack(theme.fontFamily) }}
    >
      {spec.customCSSText ? <style>{spec.customCSSText}</style> : null}
      {/* Effects render into this layer, positioned over the whole chat, so a
          generated confetti/particle effect isn't clipped by the message list's
          overflow-y-auto. Effects are responsible for cleaning up after themselves. */}
      <div ref={effectLayerRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" />

      <header
        className={`flex items-center gap-2 border-b px-4 py-3 ${headerTextClass} ${headerBorderClass}`}
        style={{ ...(dark ? { background: "#1c1c1e" } : undefined), ...(spec.customCSS.header ?? {}) }}
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ background: other?.color ?? "#c7c7cc" }}
        >
          {other?.initials ?? "…"}
        </div>
        <div className="flex-1 leading-tight">
          <div className="font-semibold">{title}</div>
          <div className={`text-[11px] ${metaTextClass}`}>active now</div>
        </div>
        <div className="flex items-center gap-1.5">
          {spec.slots.headerActions.map((action, i) => renderAction(action, i, { draft, setDraft }))}
          {customComponentsFor("headerActions")}
        </div>
      </header>

      {spec.customComponents.some((c) => c.slot === "standalone") ? (
        // Capped height so a large/badly-sized generated component (a full
        // game board, a canvas) can't squeeze the actual message list out of
        // the fixed-height chat panel — it scrolls internally instead.
        <div className="flex max-h-[240px] flex-wrap items-center gap-1.5 overflow-y-auto border-b border-black/10 bg-black/[0.02] px-3 py-1.5">
          {customComponentsFor("standalone")}
        </div>
      ) : null}

      <div
        className="flex flex-1 flex-col overflow-y-auto px-3 py-3"
        style={{ ...wallpaperStyle(theme), rowGap: rowGap(theme.density), ...(spec.customCSS.background ?? {}) }}
      >
        {pinnedMessageIds && pinnedMessageIds.size > 0 ? (
          <div className="mb-2 rounded-lg border-l-4 border-blue-400 bg-blue-50 px-3 py-2">
            <div className="text-xs font-semibold text-blue-700 mb-1">📌 Pinned</div>
            {messages
              .filter((m) => pinnedMessageIds.has(m.id))
              .map((message) => {
                const author = users.find((u) => u.id === message.authorId);
                return (
                  <div key={message.id} className="text-xs text-blue-900 mb-1 last:mb-0">
                    <strong>{author?.name}:</strong> {message.text.slice(0, 50)}
                    {message.text.length > 50 ? "…" : ""}
                  </div>
                );
              })}
          </div>
        ) : null}
        {messages.map((message) => {
          const outgoing = message.authorId === viewerId;
          const author = users.find((u) => u.id === message.authorId);
          const actions = spec.slots.messageActions.filter(
            (a) => a.on === "all" || a.on === (outgoing ? "outgoing" : "incoming"),
          );
          const tint = theme.sentimentTint && !outgoing ? sentimentColor(message.text) : null;
          const translation = translations[message.id];
          const translated = translation?.status === "shown" ? translation.text : null;

          return (
            <div key={message.id} className={`flex items-end gap-2 ${outgoing ? "flex-row-reverse" : "flex-row"}`}>
              {!outgoing && theme.showAvatars ? (
                <div
                  className="mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  style={{ background: author?.color }}
                >
                  {author?.initials}
                </div>
              ) : null}
              <div className={`flex max-w-[75%] flex-col ${outgoing ? "items-end" : "items-start"}`}>
                <div
                  style={{
                    ...bubbleStyle(theme, outgoing),
                    borderLeft: tint ? `3px solid ${tint}` : undefined,
                    ...((outgoing ? spec.customCSS.bubbleOutgoing : spec.customCSS.bubbleIncoming) ?? {}),
                  }}
                >
                  {translated ?? message.text}
                </div>
                {translated ? (
                  <div
                    className={`mt-1 max-w-[75%] text-[10px] leading-snug ${
                      dark ? "text-white/50" : "text-black/45"
                    } ${outgoing ? "text-right" : "text-left"}`}
                  >
                    <div className="font-medium">Original</div>
                    <div className="italic">&ldquo;{message.text}&rdquo;</div>
                  </div>
                ) : null}
                {(message.reactions && message.reactions.length > 0) || (starredMessageIds && starredMessageIds.has(message.id)) ? (
                  <div
                    className={`mt-1 flex items-center gap-0.5 rounded-full bg-white/85 px-1.5 py-0.5 text-xs shadow-sm ${
                      outgoing ? "self-end" : "self-start"
                    }`}
                  >
                    {message.reactions && message.reactions.map((emoji, i) => (
                      <span key={`${emoji}-${i}`}>{emoji}</span>
                    ))}
                    {starredMessageIds && starredMessageIds.has(message.id) ? (
                      <span title="starred">⭐</span>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-0.5 flex items-center gap-1.5">
                  {actions.map((action, i) =>
                    renderAction(action, i, {
                      message,
                      outgoing,
                      draft,
                      setDraft,
                      translation,
                      onTranslate: (target) => onTranslate(message.id, target),
                    }),
                  )}
                  {theme.showTimestamps ? (
                    <span className={`text-[10px] ${dark ? "text-white/45" : "text-black/35"}`}>
                      {message.time}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-black/10 bg-white px-3 py-2">
        {spec.slots.composerActions.length > 0 || spec.customComponents.some((c) => c.slot === "composerActions") ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {spec.slots.composerActions.map((action, i) => renderAction(action, i, { draft, setDraft }))}
            {customComponentsFor("composerActions")}
          </div>
        ) : null}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            onSend(text);
            setDraft("");
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="iMessage"
            className="flex-1 rounded-full border border-black/15 bg-black/[0.03] px-3 py-1.5 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40"
            style={{ background: theme.accentColor }}
          >
            {SEND_ICONS[theme.sendButtonStyle]}
          </button>
        </form>
      </div>
    </div>
  );
}
