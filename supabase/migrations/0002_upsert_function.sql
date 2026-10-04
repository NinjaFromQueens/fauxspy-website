-- Atomic insert-or-increment for community_detections, one round trip.
-- Refreshes the displayed verdict to the most recent scan (models/thresholds
-- evolve over time), but never touches first_seen_at once set.

create or replace function upsert_community_detection(
  p_content_hash text,
  p_content_type text,
  p_tier text,
  p_verdict text,
  p_category text,
  p_verdict_label text,
  p_confidence real,
  p_method text,
  p_page_domain text
) returns table (sightings_count integer, first_seen_at timestamptz)
language sql
as $$
  insert into community_detections
    (content_hash, content_type, tier, verdict, category, verdict_label, confidence, method, page_domain)
  values
    (p_content_hash, p_content_type, p_tier, p_verdict, p_category, p_verdict_label, p_confidence, p_method, p_page_domain)
  on conflict (content_hash, content_type, tier)
  do update set
    sightings_count = community_detections.sightings_count + 1,
    last_seen_at    = now(),
    verdict         = excluded.verdict,
    category        = excluded.category,
    verdict_label   = excluded.verdict_label,
    confidence      = excluded.confidence,
    method          = excluded.method,
    page_domain     = coalesce(excluded.page_domain, community_detections.page_domain)
  returning sightings_count, first_seen_at;
$$;
