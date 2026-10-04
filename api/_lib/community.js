// Community Sightings — anonymized cross-user "checked before" signal.
// Shared by api/detect.js and api/detect-video.js so both stay identical.
//
// Every function here is fail-open: a Supabase hiccup must never fail or
// noticeably slow a scan response. Missing env vars = silent no-op (feature
// stays off until Supabase is provisioned).

const crypto = require('crypto');

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
}

const SUPABASE_TIMEOUT_MS = 2500; // never let a hiccup slow down a scan response

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout`)), SUPABASE_TIMEOUT_MS))
  ]);
}

// Write path — insert-or-increment. Call after a verdict is computed.
// Never throws; returns null on any failure (including "not provisioned").
async function recordCommunitySighting({ contentHash, contentType, tier, verdict, category, verdictLabel, confidence, method, pageDomain }) {
  if (!supabase) return null;
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('upsert_community_detection', {
        p_content_hash: contentHash,
        p_content_type: contentType,
        p_tier: tier,
        p_verdict: verdict,
        p_category: category,
        p_verdict_label: verdictLabel,
        p_confidence: confidence,
        p_method: method,
        p_page_domain: pageDomain || null
      }),
      'supabase_upsert'
    );
    if (error) {
      console.warn('⚠️ [COMMUNITY] upsert failed:', error.message);
      return null;
    }
    return data?.[0] || null; // { sightings_count, first_seen_at }
  } catch (err) {
    console.warn('⚠️ [COMMUNITY] upsert threw:', err.message);
    return null;
  }
}

// Read path — used only on a cache HIT, where we don't already have a fresh count.
async function getCommunitySighting({ contentHash, contentType, tier }) {
  if (!supabase) return null;
  try {
    const { data, error } = await withTimeout(
      supabase.from('community_detections')
        .select('sightings_count, first_seen_at')
        .eq('content_hash', contentHash)
        .eq('content_type', contentType)
        .eq('tier', tier)
        .maybeSingle(),
      'supabase_read'
    );
    if (error) return null;
    return data || null;
  } catch (err) {
    console.warn('⚠️ [COMMUNITY] read threw:', err.message);
    return null;
  }
}

// Only surface the community fields once someone OTHER than the current
// scanner has hit this content — never tell the first person "checked by 0 others".
function buildCommunityFields(sighting) {
  if (!sighting || !sighting.sightings_count || sighting.sightings_count <= 1) return {};
  return {
    communitySightings: sighting.sightings_count,
    communityFirstSeenAt: sighting.first_seen_at
  };
}

module.exports = { sha256Hex, recordCommunitySighting, getCommunitySighting, buildCommunityFields };
