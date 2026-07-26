-- Piper multiplayer schema.
--
-- The scope model is enforced HERE, not just in the UI:
--   * shared rows  (messages, reactions, polls, votes) -> readable/writable by any
--     member of the conversation.
--   * personal rows (member_theme, personal_overlays)  -> readable/writable ONLY by
--     their owner. This is what makes "my appearance changes only show up for me"
--     true at the database layer.
--   * own-content-only (message edit/delete) -> author_id = auth.uid().

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New user',
  avatar_color text not null default '#0a84ff',
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  colors text[] := array['#0a84ff','#ff2d55','#34c759','#af52de','#ff9500','#30b0c7'];
begin
  insert into public.profiles (id, display_name, avatar_color)
  values (
    new.id,
    coalesce(split_part(new.email, '@', 1), 'New user'),
    colors[1 + (get_byte(decode(md5(new.id::text), 'hex'), 0) % array_length(colors, 1))]
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Conversations + membership
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  created_by uuid not null references auth.users(id) on delete cascade,
  invite_code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- SECURITY DEFINER so membership checks inside policies don't recurse through
-- conversation_members' own RLS.
create or replace function public.is_conversation_member(conv uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = auth.uid()
  );
$$;

-- Join by invite code without needing to read other people's conversations.
create or replace function public.join_conversation(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  conv uuid;
begin
  select id into conv from public.conversations where invite_code = code;
  if conv is null then
    raise exception 'invalid invite code';
  end if;
  insert into public.conversation_members (conversation_id, user_id)
  values (conv, auth.uid())
  on conflict do nothing;
  return conv;
end;
$$;

-- ---------------------------------------------------------------------------
-- Messages (shared; edit/delete restricted to the author)
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) <= 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Reactions (shared — a tapback is a social signal both people see)
-- ---------------------------------------------------------------------------
create table if not exists public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- ---------------------------------------------------------------------------
-- Polls (shared artifact + shared votes)
-- ---------------------------------------------------------------------------
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(question) <= 200),
  options jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  option_index int not null,
  primary key (poll_id, user_id)
);

-- ---------------------------------------------------------------------------
-- PERSONAL: per-member theme spec (the "only I see my changes" table)
-- ---------------------------------------------------------------------------
create table if not exists public.member_theme (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  spec jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- PERSONAL: per-member view overlays (translations today; more later)
create table if not exists public.personal_overlays (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  kind text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, message_id, kind)
);

-- ---------------------------------------------------------------------------
-- Generated background cache + usage metering
-- ---------------------------------------------------------------------------
create table if not exists public.generated_backgrounds (
  prompt_hash text primary key,
  prompt text not null,
  url text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.usage_events (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  units int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_user_time_idx
  on public.usage_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.conversations         enable row level security;
alter table public.conversation_members  enable row level security;
alter table public.messages              enable row level security;
alter table public.reactions             enable row level security;
alter table public.polls                 enable row level security;
alter table public.poll_votes            enable row level security;
alter table public.member_theme          enable row level security;
alter table public.personal_overlays     enable row level security;
alter table public.generated_backgrounds enable row level security;
alter table public.usage_events          enable row level security;

-- Profiles: anyone signed in can read (needed to render the other person's name
-- and avatar colour); you may only edit your own.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);
drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Conversations: visible to members OR to the creator (even before they join).
drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations
  for select to authenticated using (
    public.is_conversation_member(id) or created_by = auth.uid()
  );
drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations
  for insert to authenticated with check (created_by = auth.uid());

-- Membership: you can see the rows of conversations you belong to, and add yourself.
drop policy if exists members_read on public.conversation_members;
create policy members_read on public.conversation_members
  for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists members_insert on public.conversation_members;
create policy members_insert on public.conversation_members
  for insert to authenticated with check (user_id = auth.uid());

-- SHARED: messages readable by members; you may only write/modify your OWN.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (author_id = auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages
  for delete to authenticated using (author_id = auth.uid());

-- SHARED: reactions on any message in your conversations; rows are your own.
drop policy if exists reactions_read on public.reactions;
create policy reactions_read on public.reactions
  for select to authenticated using (
    exists (select 1 from public.messages m
            where m.id = message_id and public.is_conversation_member(m.conversation_id))
  );
drop policy if exists reactions_insert on public.reactions;
create policy reactions_insert on public.reactions
  for insert to authenticated with check (
    user_id = auth.uid() and
    exists (select 1 from public.messages m
            where m.id = message_id and public.is_conversation_member(m.conversation_id))
  );
drop policy if exists reactions_delete on public.reactions;
create policy reactions_delete on public.reactions
  for delete to authenticated using (user_id = auth.uid());

-- SHARED: polls + votes.
drop policy if exists polls_read on public.polls;
create policy polls_read on public.polls
  for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists polls_insert on public.polls;
create policy polls_insert on public.polls
  for insert to authenticated
  with check (created_by = auth.uid() and public.is_conversation_member(conversation_id));

drop policy if exists poll_votes_read on public.poll_votes;
create policy poll_votes_read on public.poll_votes
  for select to authenticated using (
    exists (select 1 from public.polls p
            where p.id = poll_id and public.is_conversation_member(p.conversation_id))
  );
drop policy if exists poll_votes_write on public.poll_votes;
create policy poll_votes_write on public.poll_votes
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- PERSONAL: theme + overlays are owner-only for BOTH read and write.
drop policy if exists member_theme_own on public.member_theme;
create policy member_theme_own on public.member_theme
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists personal_overlays_own on public.personal_overlays;
create policy personal_overlays_own on public.personal_overlays
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Generated backgrounds: shared cache, readable by all signed-in users.
-- Writes happen server-side with the service role, so no insert policy here.
drop policy if exists generated_backgrounds_read on public.generated_backgrounds;
create policy generated_backgrounds_read on public.generated_backgrounds
  for select to authenticated using (true);

-- Usage events: you can read your own; only the server (service role) writes.
drop policy if exists usage_events_read_own on public.usage_events;
create policy usage_events_read_own on public.usage_events
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Idempotent: re-running the whole file must not fail on "already member".
do $$
declare t text;
begin
  foreach t in array array['messages','reactions','polls','poll_votes'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when others then null;
    end;
  end loop;
end $$;
