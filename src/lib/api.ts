import { supabase } from "./supabase";

/**
 * POST to one of our own /api/* endpoints.
 *
 * In dev these are served by server/proxy.mjs (via the Vite proxy); in
 * production they are Vercel serverless functions. Same relative paths either
 * way, so nothing here is environment-specific except the auth header: the
 * deployed functions are public URLs, so they require the caller's Supabase
 * access token and meter usage against that user.
 */
export async function apiPost(path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
}
