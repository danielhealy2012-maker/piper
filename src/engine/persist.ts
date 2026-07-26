import { DEFAULT_SPEC, validateSpec, type Spec } from "./spec";

function keyFor(userId: string): string {
  return `piper:spec:${userId}`;
}

// A stored spec from an old registry version can't be trusted — re-validate
// on every load, same as model/stub output. Any miss falls back to default.
export function loadSpec(userId: string): Spec {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return DEFAULT_SPEC;
    const parsed = JSON.parse(raw);
    const result = validateSpec(parsed);
    return result.ok ? result.spec : DEFAULT_SPEC;
  } catch {
    return DEFAULT_SPEC;
  }
}

export function saveSpec(userId: string, spec: Spec): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(spec));
  } catch {
    // quota exceeded / private mode — silently ignore, spec just won't persist
  }
}
