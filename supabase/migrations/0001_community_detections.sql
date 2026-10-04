-- Anonymized, content-keyed community detection history.
-- No raw URLs, no page URLs, no userId/IP — see privacy.html for the disclosure.
-- Purpose: when the same image/video is scanned by more than one person, let the
-- API tell the next scanner "checked by N others" instead of silently reusing
-- the cached verdict with no indication it happened.

create table if not exists community_detections (
  id               bigint generated always as identity primary key,
  content_hash     text        not null,               -- sha256 hex of the resolved image/video URL
  content_type     text        not null check (content_type in ('image', 'video')),
  tier             text        not null check (tier in ('free', 'pro')),
  verdict          text        not null,                -- e.g. 'likely_ai', 'definitely_ai_art', 'ai_video'
  category         text        not null,                -- e.g. 'ai', 'digital_art', 'real' (video reuses verdict — no separate category today)
  verdict_label    text        not null,                -- human label shown in UI, e.g. "Likely AI"
  confidence       real        not null,                -- aiProbability / aiScore, 0..1
  method           text        not null,                -- e.g. 'signal_trace', 'sightengine_video_api'
  page_domain      text        null,                    -- e.g. 'www.instagram.com' — nullable, best-effort
  sightings_count  integer     not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),

  constraint community_detections_unique unique (content_hash, content_type, tier)
);

comment on table community_detections is
  'Anonymized cross-user detection history. Content is keyed only by a one-way hash of its resolved URL; no raw URL, page URL, IP, or user identifier is stored. Purpose: let a scan surface "checked by N other people" when the same content was scanned before.';

-- Only the server (service-role key) ever touches this table. Enable RLS with no
-- policies so the anon/public key — if ever exposed client-side — can't read or write it.
alter table community_detections enable row level security;
