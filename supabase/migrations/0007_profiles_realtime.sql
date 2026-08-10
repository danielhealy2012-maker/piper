-- profiles was never added to the supabase_realtime publication — only
-- messages/reactions/polls/poll_votes (0001) and shared_components/
-- shared_component_state (0003) were. subscribeConversation's client-side
-- .on("postgres_changes", {table: "profiles"}, ...) listener (added when
-- avatars shipped) subscribes correctly but Postgres never actually emits
-- anything for a table outside this publication, so avatar/display-name
-- changes had no live signal at all — only a manual reload (a REST refetch,
-- not Realtime) ever picked them up. Same idempotent pattern as 0001/0003:
-- re-running this file must not fail on "already member".
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.profiles';
  exception
    when duplicate_object then null;
    when others then null;
  end;
end $$;
