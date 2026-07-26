// Runs model-generated effect code against a container element. This is the
// "true dynamic behavior" escape hatch — see spec.ts's CustomEffectsSchema
// comment for why unvalidated JS is an accepted tradeoff here.
//
// The function body receives `container` (a real DOM node to animate into)
// and nothing else — no access to React state, network, or app internals.
// Errors are caught so a broken effect can't crash the chat UI.
export function runEffect(code: string | null | undefined, container: HTMLElement | null): void {
  if (!code || !container) return;
  try {
    const fn = new Function("container", code);
    fn(container);
  } catch (err) {
    console.warn("[effect] failed to run:", err);
  }
}
