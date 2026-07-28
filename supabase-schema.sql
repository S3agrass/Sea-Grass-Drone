-- Seagrass GCS — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Safe to re-run. Every policy is dropped before it is recreated, because
-- Postgres has no `create policy if not exists`: without the drops, re-running
-- this on a project that already has the drones table aborts on the first
-- policy and silently never reaches the media table below.

create table if not exists public.drones (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
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

-- Row Level Security: users can only see and manage their own drones.
alter table public.drones enable row level security;

drop policy if exists "Users can view their own drones" on public.drones;
create policy "Users can view their own drones"
  on public.drones for select
  using (auth.uid() = owner);

drop policy if exists "Users can register drones" on public.drones;
create policy "Users can register drones"
  on public.drones for insert
  with check (auth.uid() = owner);

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

-- Read and delete only. Note this grants access to `anon` as well as
-- `authenticated`: the app authenticates with Firebase, not Supabase, so the
-- browser only ever holds the anon key. Media is therefore unlisted rather than
-- access-controlled — anyone with the anon key (it ships in the client bundle)
-- can read it. Move auth to Supabase, or add a Postgres function gate, before
-- putting anything sensitive in here.
drop policy if exists "Anyone can view media" on public.media;
create policy "Anyone can view media"
  on public.media for select
  using (true);

drop policy if exists "Anyone can delete media" on public.media;
create policy "Anyone can delete media"
  on public.media for delete
  using (true);


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
drop policy if exists "Anyone can read media objects" on storage.objects;
create policy "Anyone can read media objects"
  on storage.objects for select
  using (bucket_id = 'media');

drop policy if exists "Anyone can delete media objects" on storage.objects;
create policy "Anyone can delete media objects"
  on storage.objects for delete
  using (bucket_id = 'media');
