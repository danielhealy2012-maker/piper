-- Lets a user leave (close the tab on) a conversation — no delete policy
-- existed for conversation_members at all before this, on either table, so
-- there was no way for a client to leave a conversation once joined.
--
-- Deliberately only removes YOUR OWN membership row, never the conversation
-- or its messages: conversations.on delete cascade means deleting the
-- conversation row itself would destroy every message in it, which is a
-- real consequence for the OTHER participant if they're still using it.
-- Leaving just makes it disappear from your own tab list (listMyConversations
-- reads conversation_members, not conversations.created_by) — the
-- conversation and the other person's access are both untouched. An
-- orphaned conversations row with zero members is harmless clutter, not a
-- problem worth a more destructive operation to avoid.
drop policy if exists members_delete_own on public.conversation_members;
create policy members_delete_own on public.conversation_members
  for delete to authenticated using (user_id = auth.uid());
