/** Turns any thrown value into a readable string. `Error` instances are the
 *  common case, but Supabase/Postgrest errors are plain objects (not `Error`
 *  subclasses) with their own `.message` — `String(err)` on those produces
 *  the useless "[object Object]" instead of the actual reason. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "Something went wrong";
}
