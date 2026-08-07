-- Atomic append for shared component state.
--
-- setSharedState() replaces the whole blob, which is correct for turn-taking
-- (a tic-tac-toe board has one writer at a time by construction) but loses
-- data the moment two people write at once. A collaborative whiteboard is
-- exactly that case: both people drawing simultaneously, each computing
-- "previous strokes + my new stroke" from their own last-seen copy, so
-- whoever writes second silently erases the other's stroke. Read-modify-write
-- from the client cannot fix this — the read and the write are separate round
-- trips with a gap in between.
--
-- This does the append INSIDE the database, in one statement, so concurrent
-- appends serialize instead of clobbering.

create or replace function public.append_shared_component_state(
  conv uuid,
  comp text,
  list_key text,
  item jsonb
)
returns jsonb
-- SECURITY INVOKER (the default, stated for emphasis): this must run as the
-- caller so the shared_component_state RLS policy still decides whether they
-- are a member of the conversation. A SECURITY DEFINER here would let any
-- signed-in user append to any conversation's state.
security invoker
language plpgsql
as $$
declare
  result jsonb;
begin
  insert into public.shared_component_state (conversation_id, component_id, state, updated_by, updated_at)
  values (conv, comp, jsonb_build_object(list_key, jsonb_build_array(item)), auth.uid(), now())
  on conflict (conversation_id, component_id) do update
    set state = jsonb_set(
          coalesce(shared_component_state.state, '{}'::jsonb),
          array[list_key],
          coalesce(shared_component_state.state -> list_key, '[]'::jsonb) || jsonb_build_array(item),
          true
        ),
        updated_by = auth.uid(),
        updated_at = now()
  returning shared_component_state.state into result;

  -- Bound the row. An append-only list has no natural end — a whiteboard can
  -- accumulate strokes all day — and every append re-broadcasts the whole row
  -- over Realtime, so an unbounded blob degrades into multi-megabyte payloads
  -- on every pen movement. Oldest entries are dropped first, which for a
  -- drawing means the earliest strokes fade out rather than the canvas
  -- breaking or writes starting to fail.
  while octet_length(result::text) > 262144 and jsonb_array_length(coalesce(result -> list_key, '[]'::jsonb)) > 1 loop
    update public.shared_component_state
      set state = jsonb_set(state, array[list_key], (state -> list_key) - 0, true)
      where conversation_id = conv and component_id = comp
      returning state into result;
  end loop;

  return result;
end;
$$;

grant execute on function public.append_shared_component_state(uuid, text, text, jsonb) to authenticated;
