import type { RealtimeChannel } from "@supabase/supabase-js";
import { requireSupabase } from "./supabase";
import type { Conversation, DbMessage, DbReaction, Profile } from "./types";
import { DEFAULT_SPEC, validateSpec, type Spec } from "../engine/spec";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function sendMagicLink(email: string): Promise<{ ok: boolean; error?: string }> {
  const sb = requireSupabase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signOut(): Promise<void> {
  await requireSupabase().auth.signOut();
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** The user's most recent conversation, creating a first one if they have none. */
export async function getOrCreateConversation(userId: string): Promise<Conversation> {
  const sb = requireSupabase();
  // Get the user's most recent conversation membership
  const { data: memberships, error: memberError } = await sb
    .from("conversation_members")
    .select("conversation_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: false })
    .limit(1);

  if (memberError) {
    console.error("[getOrCreateConversation] membership query failed:", memberError);
  } else if (memberships && memberships.length > 0) {
    console.log("[getOrCreateConversation] found existing membership, fetching conversation:", memberships[0].conversation_id);
    const { data: conv, error: convError } = await sb
      .from("conversations")
      .select("*")
      .eq("id", memberships[0].conversation_id)
      .single();
    if (convError) {
      console.error("[getOrCreateConversation] conversation fetch failed:", convError);
    } else if (conv) {
      console.log("[getOrCreateConversation] returning existing conversation:", conv.id);
      return conv as Conversation;
    }
  } else {
    console.log("[getOrCreateConversation] no existing memberships found");
  }

  console.log("[getOrCreateConversation] creating new conversation for user:", userId);
  const { data: created, error } = await sb
    .from("conversations")
    .insert({ title: "New chat", created_by: userId })
    .select("id, title, created_by, invite_code")
    .single();
  if (error) throw error;

  await sb.from("conversation_members").insert({ conversation_id: created.id, user_id: userId });
  console.log("[getOrCreateConversation] created new conversation:", created.id);
  return created as Conversation;
}

/** Join via an invite code. Runs as a SECURITY DEFINER function so the joiner
 *  doesn't need read access to conversations they're not yet in. */
export async function joinByInviteCode(code: string): Promise<string> {
  const sb = requireSupabase();
  console.log("[joinByInviteCode] calling RPC with code:", code);
  const { data, error } = await sb.rpc("join_conversation", { code });
  if (error) {
    console.error("[joinByInviteCode] RPC error:", error);
    throw error;
  }
  console.log("[joinByInviteCode] successfully joined conversation:", data);
  return data as string;
}

export async function listMembers(conversationId: string): Promise<Profile[]> {
  const sb = requireSupabase();
  const { data: members } = await sb
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId);
  const ids = (members ?? []).map((m) => m.user_id as string);
  if (ids.length === 0) return [];
  const { data: profiles } = await sb
    .from("profiles")
    .select("id, display_name, avatar_color")
    .in("id", ids);
  return (profiles ?? []) as Profile[];
}

// ---------------------------------------------------------------------------
// Messages + reactions (SHARED state)
// ---------------------------------------------------------------------------

export async function fetchMessages(conversationId: string): Promise<DbMessage[]> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DbMessage[];
}

export async function fetchReactions(conversationId: string): Promise<DbReaction[]> {
  const sb = requireSupabase();
  const { data } = await sb
    .from("reactions")
    .select("message_id, user_id, emoji, messages!inner(conversation_id)")
    .eq("messages.conversation_id", conversationId);
  return (data ?? []) as unknown as DbReaction[];
}

export async function sendMessage(conversationId: string, authorId: string, body: string) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("messages")
    .insert({ conversation_id: conversationId, author_id: authorId, body });
  if (error) throw error;
}

/** Own-content-only: RLS rejects edits to someone else's message. */
export async function editMessage(messageId: string, body: string) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("messages")
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) throw error;
}

/** Soft delete (delete-for-everyone), also own-content-only via RLS. */
export async function deleteMessage(messageId: string) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) throw error;
}

/** Shared: both participants see reactions. Toggles on repeat. */
export async function toggleReaction(messageId: string, userId: string, emoji: string) {
  const sb = requireSupabase();
  const { data: existing } = await sb
    .from("reactions")
    .select("emoji")
    .eq("message_id", messageId)
    .eq("user_id", userId)
    .eq("emoji", emoji)
    .maybeSingle();

  if (existing) {
    await sb
      .from("reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", userId)
      .eq("emoji", emoji);
  } else {
    await sb.from("reactions").insert({ message_id: messageId, user_id: userId, emoji });
  }
}

// ---------------------------------------------------------------------------
// Theme (PERSONAL state — RLS makes these rows owner-only)
// ---------------------------------------------------------------------------

export async function loadTheme(conversationId: string, userId: string): Promise<Spec> {
  const sb = requireSupabase();
  const { data } = await sb
    .from("member_theme")
    .select("spec")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data?.spec) return DEFAULT_SPEC;
  // Same distrust rule as the old localStorage loader: a spec written by an older
  // registry version can't be trusted, so re-validate and fall back.
  const result = validateSpec(data.spec);
  return result.ok ? result.spec : DEFAULT_SPEC;
}

export async function saveTheme(conversationId: string, userId: string, spec: Spec) {
  const sb = requireSupabase();
  await sb
    .from("member_theme")
    .upsert({ conversation_id: conversationId, user_id: userId, spec, updated_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** Subscribes to the shared tables for one conversation. onChange fires on any
 *  insert/update/delete so the caller can refetch a consistent view. */
export function subscribeConversation(conversationId: string, onChange: () => void): RealtimeChannel {
  const sb = requireSupabase();
  const channel = sb
    .channel(`conversation:${conversationId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
      (payload) => {
        console.log("[realtime] messages change:", payload);
        onChange();
      },
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, (payload) => {
      console.log("[realtime] reactions change:", payload);
      onChange();
    })
    .subscribe((status) => {
      console.log(`[realtime] subscription status: ${status}`);
    });
  return channel;
}

// ---------------------------------------------------------------------------
// Conversation operations
// ---------------------------------------------------------------------------

export async function updateConversationTitle(conversationId: string, title: string) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("conversations")
    .update({ title })
    .eq("id", conversationId);
  if (error) throw error;
}

export async function clearConversationMessages(conversationId: string) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .is("deleted_at", null);
  if (error) throw error;
}
