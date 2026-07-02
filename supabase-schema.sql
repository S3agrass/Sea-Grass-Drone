-- Seagrass GCS — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).

create table if not exists public.drones (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  name text not null,
  host text not null default 'ws://seagrass-pi.local:8765',
  camera_url text default 'http://seagrass-pi.local:8000/stream.mjpg',
  token text default '',
  created_at timestamptz not null default now()
);

-- Row Level Security: users can only see and manage their own drones.
alter table public.drones enable row level security;

create policy "Users can view their own drones"
  on public.drones for select
  using (auth.uid() = owner);

create policy "Users can register drones"
  on public.drones for insert
  with check (auth.uid() = owner);

create policy "Users can update their own drones"
  on public.drones for update
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create policy "Users can remove their own drones"
  on public.drones for delete
  using (auth.uid() = owner);
