-- Seagrass GCS — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Safe to re-run. Every policy is dropped before it is recreated, because
-- Postgres has no `create policy if not exists`: without the drops, re-running
-- this on a project that already has the drones table aborts on the first
-- policy and silently never reaches the media table below.

create table if not exists public.drones (
  id uuid primary key default gen_random_uuid(),
  -- The Supabase auth.uid() of whoever registered this drone. The app now
  -- authenticates against Supabase, so this is a real user id and RLS can
  -- actually enforce on it. (It was previously a Firebase UID stored as text,
  -- which auth.uid() could never match — see the migration note below.)
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  host text not null default 'ws://seagrass-pi.local:8765',
  camera_url text default 'http://seagrass-pi.local:8000/stream.mjpg',
  -- Optional override for where photos/recordings are browsed. Blank means
  -- "the camera host on port 8000", which is where camera_stream.py serves
  -- /media — the camera_url itself may point at MediaMTX on :8889, which does not.
  media_url text default '',
  -- Matches DRONE_ID on the vehicle; scopes the media listing to this drone.
  -- Blank shows every drone's captures.
  drone_id text default '',
  token text default '',
  created_at timestamptz not null default now()
);

-- Existing installs: add the columns without recreating the table.
alter table public.drones add column if not exists media_url text default '';
alter table public.drones add column if not exists drone_id text default '';

-- Existing installs from before this fix: the OLD policies below reference the
-- owner column directly, and Postgres refuses to change a column's type while
-- any policy depends on it ("cannot alter type of a column used in a policy
-- definition") — so those specific policies must be dropped BEFORE the alter,
-- not after. They're recreated (relaxed, renamed) further down.
drop policy if exists "Users can view their own drones" on public.drones;
drop policy if exists "Users can register drones" on public.drones;
drop policy if exists "Users can update their own drones" on public.drones;
drop policy if exists "Users can remove their own drones" on public.drones;

-- ---------------------------------------------------------------------------
-- MIGRATION off Firebase Auth. Read this before running.
-- ---------------------------------------------------------------------------
-- While the app authenticated with Firebase there was no Supabase session, so
-- auth.uid() was NULL and the policies below had to be `using (true)` — every
-- account saw and could edit every drone. Worse, the client wrote `user?.id`
-- from a Firebase user object whose property is actually `uid`, so the owner
-- column reads the literal string "local" on EVERY existing row regardless of
-- who created it.
--
-- Those rows therefore cannot be attributed to anyone, by anybody, ever: the
-- information simply was not recorded. The line below deletes them so the
-- column can become a real uuid FK.
--
--   *** THIS DELETES EXISTING DRONE REGISTRATIONS. ***
--
-- They are only a name, host and URL, so re-adding them takes a few seconds
-- per drone — but take a copy first if you want them:
--   select * from public.drones;
-- Captured media is NOT touched by this.
delete from public.drones where owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Now the column can carry a genuine Supabase user id again.
alter table public.drones alter column owner type uuid using owner::uuid;
alter table public.drones alter column owner set default auth.uid();
alter table public.drones drop constraint if exists drones_owner_fkey;
alter table public.drones
  add constraint drones_owner_fkey foreign key (owner)
  references auth.users(id) on delete cascade;

-- Row Level Security, genuinely scoped this time. auth.uid() is a real value on
-- every request now that sign-in is Supabase's, so Postgres enforces the
-- boundary. This is the part that has to be right: the anon key ships inside
-- the client bundle, so anyone can call the REST API directly — filtering in
-- the browser would look identical in the UI and protect nothing.
alter table public.drones enable row level security;

-- The permissive policies from the Firebase era. Dropped by their old names so
-- re-running this on an existing project actually removes them; leaving any one
-- in place would keep the table world-readable, because policies OR together.
drop policy if exists "Anyone can view drones" on public.drones;
drop policy if exists "Anyone can register drones" on public.drones;
drop policy if exists "Anyone can update drones" on public.drones;
drop policy if exists "Anyone can remove drones" on public.drones;

drop policy if exists "Users can view their own drones" on public.drones;
create policy "Users can view their own drones"
  on public.drones for select
  using (auth.uid() = owner);

-- with check, not using: this is what stops someone inserting a row that claims
-- to belong to another account.
drop policy if exists "Users can register drones" on public.drones;
create policy "Users can register drones"
  on public.drones for insert
  with check (auth.uid() = owner);

-- Both clauses. `using` decides which rows you may edit, `with check` decides
-- what they may look like afterwards — without the latter you could hand your
-- drone to someone else by rewriting owner.
drop policy if exists "Users can update their own drones" on public.drones;
create policy "Users can update their own drones"
  on public.drones for update
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop policy if exists "Users can remove their own drones" on public.drones;
create policy "Users can remove their own drones"
  on public.drones for delete
  using (auth.uid() = owner);


-- ---------------------------------------------------------------------------
-- Captured media
-- ---------------------------------------------------------------------------
-- One row per photo/recording the drone has uploaded. The bytes live in the
-- `media` storage bucket; this table is the index the Media page reads.
--
-- The ONLY writer is server/media_uploader.py on the Pi, using the service_role
-- key. service_role bypasses RLS, which is exactly why the policies below grant
-- no insert or update to anyone: a browser must never be able to forge or edit
-- a record of what the vehicle saw.

create table if not exists public.media (
  -- "{drone_id}__{filename}". Deterministic so an upload retried after a
  -- mid-flight crash overwrites its own row instead of duplicating it.
  id text primary key,
  drone_id text not null,
  name text not null,
  type text not null check (type in ('photo', 'video')),
  size bigint,
  captured_at timestamptz,
  storage_path text not null,
  -- 'manual' (operator pressed the button), 'auto' (the detector fired), or
  -- 'unknown' (backfilled from a file with no sidecar).
  trigger text default 'unknown',
  -- Why the capture happened: detector label + confidence, and the depth,
  -- heading and position at that instant. Null-filled where unavailable.
  context jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz not null default now()
);

create index if not exists media_drone_captured_idx
  on public.media (drone_id, captured_at desc);

alter table public.media enable row level security;

-- Read and delete only, and scoped to the signed-in operator. There is no owner
-- column here — the Pi writes these rows and only knows its own DRONE_ID — so
-- ownership is reached through the drones table: you can see a capture if you
-- own a drone whose drone_id it was filed under.
--
-- The `drone_id <> ''` guard is load-bearing. Blank drone_id on a drones row is
-- a UI convention meaning "show every drone's captures", and without the guard
-- a single blank-id registration would match every blank-id media row in the
-- table — including other people's.
drop policy if exists "Anyone can view media" on public.media;
drop policy if exists "Anyone can delete media" on public.media;

drop policy if exists "Users can view media from their drones" on public.media;
create policy "Users can view media from their drones"
  on public.media for select
  using (
    exists (
      select 1 from public.drones d
      where d.owner = auth.uid()
        and d.drone_id <> ''
        and d.drone_id = public.media.drone_id
    )
  );

drop policy if exists "Users can delete media from their drones" on public.media;
create policy "Users can delete media from their drones"
  on public.media for delete
  using (
    exists (
      select 1 from public.drones d
      where d.owner = auth.uid()
        and d.drone_id <> ''
        and d.drone_id = public.media.drone_id
    )
  );


-- ---------------------------------------------------------------------------
-- Storage bucket
-- ---------------------------------------------------------------------------
-- Private bucket: reads go through short-lived signed URLs rather than
-- permanent public links.
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- If these two statements fail with "must be owner of table objects", create
-- the bucket and its policies from Dashboard → Storage instead; some projects
-- don't grant the SQL editor's role ownership of the storage schema. Everything
-- above this line will already have committed.
-- Scoped the same way as the media table: the bytes are reachable only if you
-- own the drone the indexing row was filed under. Without this the table could
-- be perfectly locked down while every object stayed downloadable straight from
-- the storage API by anyone holding the anon key.
drop policy if exists "Anyone can read media objects" on storage.objects;
drop policy if exists "Anyone can delete media objects" on storage.objects;

drop policy if exists "Users can read their media objects" on storage.objects;
create policy "Users can read their media objects"
  on storage.objects for select
  using (
    bucket_id = 'media'
    and exists (
      select 1
      from public.media m
      join public.drones d
        on d.drone_id = m.drone_id and d.drone_id <> ''
      where m.storage_path = storage.objects.name
        and d.owner = auth.uid()
    )
  );

drop policy if exists "Users can delete their media objects" on storage.objects;
create policy "Users can delete their media objects"
  on storage.objects for delete
  using (
    bucket_id = 'media'
    and exists (
      select 1
      from public.media m
      join public.drones d
        on d.drone_id = m.drone_id and d.drone_id <> ''
      where m.storage_path = storage.objects.name
        and d.owner = auth.uid()
    )
  );
