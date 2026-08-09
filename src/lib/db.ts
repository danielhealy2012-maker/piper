import type { RealtimeChannel } from "@supabase/supabase-js";
import { requireSupabase } from "./supabase";
import type { Conversation, DbMessage, DbReaction, Profile } from "./types";
import { DEFAULT_SPEC, validateSpec, type CustomComponentSlot, type Spec } from "../engine/spec";

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
    .select("id, display_name, avatar_color, avatar_url")
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

/** Bulk soft-delete every message from one author in a conversation. Returns
 *  the ids actually deleted, so the caller can build an undo (unremove each). */
export async function deleteAllMessagesByAuthor(conversationId: string, authorId: string): Promise<string[]> {
  const sb = requireSupabase();
  const { data: rows, error: selectError } = await sb
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("author_id", authorId)
    .is("deleted_at", null);
  if (selectError) throw selectError;
  const ids = (rows ?? []).map((r) => r.id as string);
  if (ids.length === 0) return [];

  const { error } = await sb
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
  return ids;
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

/** Removes exactly the viewer's own reaction — a real delete, not a toggle.
 *  RLS only allows deleting your own reaction rows (`user_id = auth.uid()`),
 *  so this can never remove someone else's; returns false rather than
 *  silently adding one when the viewer has no such reaction to remove. */
export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("reactions")
    .delete()
    .eq("message_id", messageId)
    .eq("user_id", userId)
    .eq("emoji", emoji)
    .select("emoji");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Removes all of the viewer's own reactions on a message; returns the
 *  removed emojis so the caller can build an undo. */
export async function removeAllReactionsForMessage(messageId: string, userId: string): Promise<string[]> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("reactions")
    .delete()
    .eq("message_id", messageId)
    .eq("user_id", userId)
    .select("emoji");
  if (error) throw error;
  return (data ?? []).map((r) => r.emoji as string);
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
// Nicknames (PERSONAL state — supabase/migrations/0005_member_nicknames.sql)
// ---------------------------------------------------------------------------
// One row per viewer: a JSONB map of target user id -> nickname. Same
// deploy-ahead-of-schema window as shared_components (see isMissingTable
// above) — degrades to "no nicknames" rather than breaking the load.

export async function fetchNicknames(
  conversationId: string,
  userId: string,
): Promise<Record<string, string>> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("member_nicknames")
    .select("nicknames")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      console.warn(
        "[piper] member_nicknames table missing — run supabase/migrations/0005_member_nicknames.sql. Nicknames are unavailable until then; the rest of the app is unaffected.",
      );
      return {};
    }
    throw error;
  }
  const raw = data?.nicknames;
  return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
}

export async function saveNicknames(
  conversationId: string,
  userId: string,
  nicknames: Record<string, string>,
) {
  const sb = requireSupabase();
  const { error } = await sb.from("member_nicknames").upsert({
    conversation_id: conversationId,
    user_id: userId,
    nicknames: nicknames as never,
    updated_at: new Date().toISOString(),
  });
  if (error && !isMissingTable(error)) throw error;
}

// ---------------------------------------------------------------------------
// SHARED custom components (supabase/migrations/0003_shared_components.sql)
// ---------------------------------------------------------------------------
// Unlike member_theme above, these are conversation-scoped: RLS lets any
// member read and write them, so whatever one person adds shows up for both.

export interface SharedComponentRow {
  id: string;
  label: string;
  slot: CustomComponentSlot;
  code: string;
  createdBy: string;
}

// Migrations in this project are applied BY HAND in the Supabase SQL editor
// (see SETUP.md), while code ships automatically on push to main. So there is
// always a window where deployed code is ahead of the schema. These two
// readers must degrade to "no shared components" in that window rather than
// throw: they're awaited inside the same Promise.all as messages, users and
// the theme in Workspace's initial load, so a rejection here doesn't just
// hide widgets — it takes down the entire chat and renders a blank app.
// Additive features must never be able to do that.
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  // 42P01 = undefined_table. PostgREST also 404s an unknown table before it
  // ever reaches Postgres, hence the message check.
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    /does not exist|schema cache/i.test(error?.message ?? "")
  );
}

export async function fetchSharedComponents(conversationId: string): Promise<SharedComponentRow[]> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("shared_components")
    .select("component_id, label, slot, code, created_by")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      console.warn(
        "[piper] shared_components table missing — run supabase/migrations/0003_shared_components.sql. Shared widgets are unavailable until then; the rest of the app is unaffected.",
      );
      return [];
    }
    throw error;
  }
  return (data ?? []).map((r) => ({
    id: r.component_id as string,
    label: r.label as string,
    slot: r.slot as CustomComponentSlot,
    code: r.code as string,
    createdBy: r.created_by as string,
  }));
}

export async function fetchSharedComponentState(
  conversationId: string,
): Promise<Record<string, unknown>> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("shared_component_state")
    .select("component_id, state")
    .eq("conversation_id", conversationId);
  if (error) {
    // Same deploy-ahead-of-schema window as fetchSharedComponents above.
    if (isMissingTable(error)) return {};
    throw error;
  }
  return Object.fromEntries((data ?? []).map((r) => [r.component_id as string, r.state]));
}

/** Upsert on (conversation_id, component_id): re-issuing the same id is how an
 *  instruction MODIFIES an existing shared component rather than duplicating it. */
export async function saveSharedComponent(
  conversationId: string,
  userId: string,
  component: { id: string; label: string; slot: CustomComponentSlot; code: string },
) {
  const sb = requireSupabase();
  const { error } = await sb.from("shared_components").upsert(
    {
      conversation_id: conversationId,
      component_id: component.id,
      label: component.label,
      slot: component.slot,
      code: component.code,
      created_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id,component_id" },
  );
  if (error) throw error;
}

/** A real delete, not a soft one. The state row goes with it via the composite
 *  foreign key's ON DELETE CASCADE — a re-added component of the same name
 *  starts fresh rather than inheriting a stale board. */
export async function deleteSharedComponent(conversationId: string, componentId: string) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("shared_components")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("component_id", componentId);
  if (error) throw error;
}

/** The write behind `setSharedState` inside a compiled component — one move in
 *  a game, one item ticked off a list. Deliberately writes only the state
 *  table, so a move doesn't rewrite (or re-broadcast) the component's source. */
export async function writeSharedComponentState(
  conversationId: string,
  componentId: string,
  userId: string,
  state: unknown,
) {
  const sb = requireSupabase();
  const { error } = await sb.from("shared_component_state").upsert(
    {
      conversation_id: conversationId,
      component_id: componentId,
      state: state as never,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id,component_id" },
  );
  if (error) throw error;
}

/**
 * Atomic append to a list inside a component's shared state — the write
 * behind `appendSharedState` (supabase/migrations/0004).
 *
 * Needed because `writeSharedComponentState` above replaces the whole blob:
 * two people drawing on a whiteboard at the same time each compute "existing
 * strokes + mine" from their own last-seen copy, and whoever writes second
 * erases the other's stroke. The append happens inside the database in one
 * statement, so concurrent writers serialize instead of clobbering.
 */
export async function appendSharedComponentState(
  conversationId: string,
  componentId: string,
  listKey: string,
  item: unknown,
): Promise<void> {
  const sb = requireSupabase();
  const { error } = await sb.rpc("append_shared_component_state", {
    conv: conversationId,
    comp: componentId,
    list_key: listKey,
    item: item as never,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** Subscribes to the shared tables for one conversation. onChange fires on any
 *  insert/update/delete so the caller can refetch a consistent view. */
export function subscribeConversation(conversationId: string, onChange: () => void): RealtimeChannel[] {
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

  // Shared components and their state get their OWN channel rather than
  // riding the one above. Deployed code can be ahead of the hand-applied
  // schema (see fetchSharedComponents), and a postgres_changes binding to a
  // table that doesn't exist yet can fail the whole channel — which, on a
  // shared channel, would silently take live messages down with it. Isolated,
  // the worst case is that shared widgets aren't live until the migration
  // runs, and messages keep working.
  const sharedChannel = sb
    .channel(`conversation-shared:${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "shared_components",
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => {
        console.log("[realtime] shared_components change:", payload);
        onChange();
      },
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "shared_component_state",
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => {
        console.log("[realtime] shared_component_state change:", payload);
        onChange();
      },
    )
    .subscribe((status) => {
      console.log(`[realtime] shared-component subscription status: ${status}`);
      if (status === "CHANNEL_ERROR") {
        console.warn(
          "[piper] shared-component realtime unavailable — has supabase/migrations/0003_shared_components.sql been run? Messages are unaffected.",
        );
      }
    });

  return [channel, sharedChannel];
}

// ---------------------------------------------------------------------------
// Typing indicators (Phase 2 #16) — Realtime BROADCAST, not postgres_changes.
// ---------------------------------------------------------------------------
// Deliberately no table, no migration: "is someone typing right now" is
// ephemeral, ceases to matter the instant it's stale, and would be pure
// write churn as a DB row (one row rewritten on every keystroke, broadcast
// to Realtime either way). Broadcast is peer-to-peer over the same
// websocket messages/shared-components already use — nothing new to
// provision. Own channel so a burst of typing events can never compete with
// or delay the messages/shared-component channels above.

export function subscribeTyping(
  conversationId: string,
  viewerId: string,
  onTyping: (fromUserId: string) => void,
): RealtimeChannel {
  const sb = requireSupabase();
  return sb
    .channel(`conversation-typing:${conversationId}`)
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      const from = (payload as { userId?: string } | undefined)?.userId;
      // Ignore our own broadcast — Supabase Realtime echoes it back to the
      // sender by default, and a "you are typing" indicator would be a bug.
      if (from && from !== viewerId) onTyping(from);
    })
    .subscribe();
}

/** Fire-and-forget: caller (Workspace) is responsible for debouncing so this
 *  isn't sent on every keystroke. Uses supabase-js's REST-based broadcast
 *  send, which works without first subscribing/joining a socket — a fresh
 *  short-lived channel object per call is the documented pattern for a
 *  one-off send, not a leak; there's no long-lived connection to clean up. */
export function sendTyping(conversationId: string, userId: string) {
  const sb = requireSupabase();
  void sb.channel(`conversation-typing:${conversationId}`).send({
    type: "broadcast",
    event: "typing",
    payload: { userId },
  });
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
