import { Component as ReactClassComponent, useMemo, type ReactNode } from "react";
import type { CustomComponent } from "../engine/spec";
import { compileCustomComponent, useBabel } from "./customComponentRuntime";

interface Props {
  spec: CustomComponent;
  messages: unknown[];
  viewerId: string;
  sendMessage: (text: string) => void;
  onRemove: (id: string) => void;
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
export function CustomComponentSlot({ spec, messages, viewerId, sendMessage, onRemove }: Props) {
  const babel = useBabel();

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
          <result.Comp messages={messages} viewerId={viewerId} sendMessage={sendMessage} />
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
