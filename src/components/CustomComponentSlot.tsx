import { Component as ReactClassComponent, useCallback, useMemo, useState, type ReactNode } from "react";
import type { CustomComponent } from "../engine/spec";
import { compileCustomComponent, useBabel } from "./customComponentRuntime";

interface Props {
  spec: CustomComponent;
  messages: unknown[];
  viewerId: string;
  sendMessage: (text: string) => void;
  onRemove: (id: string) => void;
  /** For scope:"shared" components: the live value from the conversation, and
   *  the writer that syncs it to the other person. Omitted for personal ones,
   *  which fall back to local state below. */
  sharedState?: unknown;
  onSetSharedState?: (componentId: string, next: unknown) => void;
  onAppendSharedState?: (componentId: string, listKey: string, item: unknown) => void;
}

// Error boundaries must be class components — this only catches RENDER-time
// failures of an already-compiled component (a bad useEffect, a thrown
// exception mid-render). Compile-time failures (bad JSX) are caught
// separately below, before this ever mounts.
class ComponentErrorBoundary extends ReactClassComponent<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <span className="text-[11px] text-red-600">
          "{this.props.label}" crashed: {this.state.error.message.slice(0, 80)}
        </span>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders one model-authored custom component. Always shows a small ✕
 * regardless of whether it's currently working or broken — the guaranteed,
 * model-independent way out of a bad component, since unlike a one-shot
 * customEffect, a bad component can misbehave for as long as it stays
 * mounted. The ✕ is an absolutely-positioned corner badge, not a flex
 * sibling of the component's content — a component that renders something
 * large or uses its own absolute/fixed positioning internally could
 * otherwise cover or displace a same-flow button, which is exactly what
 * made a generated widget briefly unremovable in practice.
 */
export function CustomComponentSlot({
  spec,
  messages,
  viewerId,
  sendMessage,
  onRemove,
  sharedState,
  onSetSharedState,
  onAppendSharedState,
}: Props) {
  const babel = useBabel();

  // A personal component still gets the sharedState prop pair, backed by
  // ordinary local state. The model is told which scope to use, but if it
  // marks something personal and then writes against setSharedState anyway,
  // the widget should still work locally rather than crash on an undefined
  // function — the prop contract is uniform, only the backing store differs.
  const [localState, setLocalState] = useState<unknown>(null);
  const isShared = spec.scope === "shared" && !!onSetSharedState;

  // Accepts a value or an updater function, matching useState's contract —
  // which is what a component doing `setSharedState(s => ({...s, ...}))` will
  // reach for by habit, and what makes concurrent moves less lossy than
  // read-modify-write against a stale render's copy.
  const setSharedState = useCallback(
    (next: unknown) => {
      const current = isShared ? sharedState : localState;
      const resolved = typeof next === "function" ? (next as (prev: unknown) => unknown)(current) : next;
      if (isShared) onSetSharedState?.(spec.id, resolved);
      else setLocalState(resolved);
    },
    [isShared, sharedState, localState, onSetSharedState, spec.id],
  );

  // Personal components get a local equivalent so the prop contract stays
  // uniform — it just has nobody to race with.
  const appendSharedState = useCallback(
    (listKey: string, item: unknown) => {
      if (isShared) {
        onAppendSharedState?.(spec.id, listKey, item);
        return;
      }
      setLocalState((prev: unknown) => {
        const current = (prev ?? {}) as Record<string, unknown>;
        const list = Array.isArray(current[listKey]) ? (current[listKey] as unknown[]) : [];
        return { ...current, [listKey]: [...list, item] };
      });
    },
    [isShared, onAppendSharedState, spec.id],
  );

  const result = useMemo<
    { kind: "ok"; Comp: ReturnType<typeof compileCustomComponent> } | { kind: "error"; error: string } | null
  >(() => {
    if (!babel) return null;
    try {
      return { kind: "ok", Comp: compileCustomComponent(babel, spec.code) };
    } catch (err) {
      return { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }, [babel, spec.code]);

  return (
    <span className="relative inline-flex max-w-full items-center rounded-full bg-white/80 py-0.5 pl-2 pr-5 shadow-sm backdrop-blur-sm">
      {!result ? (
        <span className="text-[11px] text-black/40">loading "{spec.label}"…</span>
      ) : result.kind === "error" ? (
        <span className="text-[11px] text-red-600">
          "{spec.label}" couldn't build: {result.error.slice(0, 80)}
        </span>
      ) : (
        <ComponentErrorBoundary label={spec.label}>
          <result.Comp
            messages={messages}
            viewerId={viewerId}
            sendMessage={sendMessage}
            sharedState={isShared ? sharedState : localState}
            setSharedState={setSharedState}
            appendSharedState={appendSharedState}
          />
        </ComponentErrorBoundary>
      )}
      <button
        type="button"
        onClick={() => onRemove(spec.id)}
        title={`Remove "${spec.label}"`}
        className="absolute right-0.5 top-0.5 z-50 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] text-black/50 shadow ring-1 ring-black/10 hover:text-red-500"
      >
        ✕
      </button>
    </span>
  );
}
