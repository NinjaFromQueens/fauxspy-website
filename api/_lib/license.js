// Server-side Pro check for the scan endpoints.
//
// The extension sends `isPro`, but that's only a claim — it lives in the
// user's own browser storage and can be set to anything. Pro status comes
// from a license key that exists in Redis and passes the same rules as
// /api/validate-license (not cancelled or inactive, not expired beyond the
// 3-day grace period), so the scan endpoints and the extension agree on what
// "valid" means.

const DEV_KEY = 'FAUX-DEV0-TEST-ACCS-0001';
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const KEY_FORMAT = /^FAUX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * Returns { isPro, key, license, reason }.
 *   license — the Redis record when found (null for the dev key or an
 *             unverified lookup), used for token checks and deduction.
 *   reason  — why Pro was refused, for logs.
 */
async function resolveProLicense(kv, licenseKey) {
  if (!licenseKey || typeof licenseKey !== 'string') return { isPro: false, key: null, license: null, reason: 'no_key' };

  const key = licenseKey.trim().toUpperCase();
  if (process.env.DEV_LICENSE_ENABLED === 'true' && key === DEV_KEY) {
    return { isPro: true, key, license: null, reason: null };
  }
  if (!KEY_FORMAT.test(key)) return { isPro: false, key: null, license: null, reason: 'invalid_format' };

  let license;
  try {
    license = await kv.get(`license:${key}`);
  } catch (err) {
    // Redis is unreachable, so the key can't be checked either way. Don't lock
    // paying users out during an outage; the free-tier counters are degraded
    // at the same time anyway.
    console.warn('⚠️ [LICENSE] Lookup failed, allowing unverified Pro:', err.message);
    return { isPro: true, key, license: null, reason: null };
  }

  if (!license) return { isPro: false, key: null, license: null, reason: 'not_found' };
  if (license.status === 'cancelled' || license.status === 'inactive') {
    return { isPro: false, key: null, license: null, reason: license.status };
  }
  if (license.expiresAt && Date.now() > license.expiresAt + GRACE_MS) {
    return { isPro: false, key: null, license: null, reason: 'expired' };
  }
  return { isPro: true, key, license, reason: null };
}

module.exports = { resolveProLicense };
