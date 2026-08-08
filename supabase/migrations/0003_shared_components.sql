-- SHARED custom components — the third scope in this schema.
--
-- Until now every model-authored widget lived in `member_theme`, which is
-- owner-only by RLS. That was inherited from the theme system's personal-scope
-- design, not a decision about widgets, and it made a whole class of request
-- impossible: a generated tic-tac-toe board rendered only for the person who
-- asked for it, and even if the other person could see it, the game state was
-- local `useState` inside the compiled component, so nothing about it synced.
--
-- Scope model here matches messages and reactions, NOT member_theme: any
-- member of the conversation may read AND write. There is deliberately no
-- approval gate — whatever one person sets applies for both, the same trust
-- model a message or a tapback already has. Explicitly confirmed with the
-- owner, including the new failure shape it introduces: a broken or hostile
-- shared component now misbehaves for BOTH people, not just its author. The
-- always-present per-component "✕" is the escape hatch, same as personal ones.

-- ---------------------------------------------------------------------------
-- The component definition (code, label, where it mounts)
-- ---------------------------------------------------------------------------
create table if not exists public.shared_components (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- The model-authored slug (e.g. "tic-tac-toe"), not a uuid: it's how an
  -- instruction like "make the tic-tac-toe board bigger" re-identifies an
  -- existing component, and it's what the client's removal affordance keys on.
  component_id text not null check (char_length(component_id) between 1 and 40),
  label text not null check (char_length(label) between 1 and 60),
  slot text not null check (slot in ('composerActions', 'headerActions', 'standalone')),
  code text not null check (char_length(code) <= 6000),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, component_id)
);

-- ---------------------------------------------------------------------------
-- The component's shared state, deliberately a SEPARATE table
-- ---------------------------------------------------------------------------
-- State changes on a different timescale than the code does: a tic-tac-toe
-- board is defined once and then written on every move, and a collaborative
-- whiteboard writes on every stroke. Realtime broadcasts the whole changed
-- row, so keeping state on the definition row would re-send the component's
-- entire source code on every move. Splitting it keeps a state update small.
create table if not exists public.shared_component_state (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  component_id text not null,
  state jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, component_id),
  foreign key (conversation_id, component_id)
    references public.shared_components (conversation_id, component_id) on delete cascade
);

alter table public.shared_components      enable row level security;
alter table public.shared_component_state enable row level security;

-- SHARED: any conversation member, full access. `created_by = auth.uid()` is
-- checked on INSERT only so the attribution column stays honest — it is not a
-- permission boundary, since either member may edit or remove either's
-- components by design.
drop policy if exists shared_components_read on public.shared_components;
create policy shared_components_read on public.shared_components
  for select to authenticated using (public.is_conversation_member(conversation_id));

drop policy if exists shared_components_insert on public.shared_components;
create policy shared_components_insert on public.shared_components
  for insert to authenticated
  with check (created_by = auth.uid() and public.is_conversation_member(conversation_id));

drop policy if exists shared_components_update on public.shared_components;
create policy shared_components_update on public.shared_components
  for update to authenticated
  using (public.is_conversation_member(conversation_id))
  with check (public.is_conversation_member(conversation_id));

drop policy if exists shared_components_delete on public.shared_components;
create policy shared_components_delete on public.shared_components
  for delete to authenticated using (public.is_conversation_member(conversation_id));

drop policy if exists shared_component_state_all on public.shared_component_state;
create policy shared_component_state_all on public.shared_component_state
  for all to authenticated
  using (public.is_conversation_member(conversation_id))
  with check (public.is_conversation_member(conversation_id));

-- ---------------------------------------------------------------------------
-- Realtime — this is what makes the other player's move actually appear
-- ---------------------------------------------------------------------------
-- Idempotent, matching 0001_init.sql: re-running the file must not fail on
-- "already member of publication".
do $$
declare t text;
begin
  foreach t in array array['shared_components','shared_component_state'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when others then null;
    end;
  end loop;
end $$;

-- Realtime UPDATE payloads only carry the primary key in `old_record` under
-- the default REPLICA IDENTITY, which is enough here (the client refetches
-- rather than applying payloads directly), but FULL makes the state diff
-- visible to any future subscriber that wants to apply it in place.
alter table public.shared_component_state replica identity full;
