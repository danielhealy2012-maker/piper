-- Custom nicknames per viewer (Phase 2 #12) — "call Sam 'Sammy'".
--
-- PERSONAL, not shared: how you see the other person's display name is your
-- own business, not a change to their actual profile. Same scope model as
-- member_theme (owner-only via RLS), not the shared-components scope from
-- 0003 — a nickname is the opposite case, one person's private view.
--
-- Deliberately its own table rather than folded into the Spec (member_theme's
-- JSONB blob): Spec is the model-generated theme object, echoed back verbatim
-- on every /api/generate call. Nicknames are never touched by the theming
-- model at all — set/cleared directly by the router's setNickname/
-- clearNickname message actions, no model round-trip needed to store them.
-- Keeping them out of Spec avoids a new way for the "model silently drops a
-- field it wasn't told to preserve" bug class to happen.
--
-- One row per viewer holding a small JSONB map (target user id -> nickname),
-- matching member_theme's shape, rather than one row per (viewer, target)
-- pair — simpler for a 2-person conversation and trivially extends to more.
create table if not exists public.member_nicknames (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nicknames jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.member_nicknames enable row level security;

drop policy if exists member_nicknames_own on public.member_nicknames;
create policy member_nicknames_own on public.member_nicknames
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
