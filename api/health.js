// /api/health.js
// API health check endpoint — called by the health-monitor GitHub Actions job every hour.
// Returns JSON status for all detection APIs.
// Protected by ADMIN_TOKEN.

const crypto = require('crypto');

module.exports = async (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  const secret = process.env.ADMIN_TOKEN;
  const valid = token && secret &&
    token.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = {
    checkedAt: new Date().toISOString(),
    checks: {},
  };

  // Sightengine check — calls check.json with no image to get a "missing url" error back.
  // Any valid JSON response proves the API is up and credentials are accepted.
  // No credits consumed.
  try {
    const apiUser = process.env.SIGHTENGINE_API_USER;
    const apiSecret = process.env.SIGHTENGINE_API_SECRET;

    if (!apiUser || !apiSecret) {
      results.checks.sightengine = { status: 'skip', reason: 'Credentials not configured' };
    } else {
      const url = `https://api.sightengine.com/1.0/check.json?api_user=${encodeURIComponent(apiUser)}&api_secret=${encodeURIComponent(apiSecret)}&models=nudity`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();

      // Bad credentials → explicit error code from Sightengine
      if (data.error?.code === 1 || data.error?.type === 'invalid_credentials') {
        results.checks.sightengine = { status: 'fail', error: 'Invalid API credentials' };
      } else {
        // Any other JSON response (including "missing url" error) means the API is up
        results.checks.sightengine = { status: 'ok' };
      }
    }
  } catch (err) {
    results.checks.sightengine = { status: 'fail', error: err.message };
  }

  // TheHive — basic connectivity check (no test call, just DNS resolution)
  try {
    const resp = await fetch('https://api.thehive.ai/', {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    // Any response (even 404/401) means the service is reachable
    results.checks.thehive = { status: resp.status < 500 ? 'ok' : 'fail', httpStatus: resp.status };
  } catch (err) {
    results.checks.thehive = { status: 'fail', error: err.message };
  }

  const anyFail = Object.values(results.checks).some(c => c.status === 'fail');
  results.overall = anyFail ? 'fail' : 'ok';

  return res.status(200).json(results);
};
