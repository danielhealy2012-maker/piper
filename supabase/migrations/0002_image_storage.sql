-- Storage bucket for AI-generated background images (api/image.js).
--
-- Public bucket: objects are served via a stable public URL with no RLS read
-- policy needed (public buckets bypass object-level RLS for reads). Writes
-- happen ONLY server-side via api/image.js using the service role key, which
-- bypasses RLS entirely — so no insert/update policy is needed either. The
-- generated_backgrounds cache table (0001_init.sql) already has its own read
-- policy; this migration only adds the bucket the actual image bytes live in.
insert into storage.buckets (id, name, public)
values ('backgrounds', 'backgrounds', true)
on conflict (id) do nothing;
