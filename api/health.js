// /api/health.js
// API health check endpoint — called by the health-monitor GitHub Actions job every hour.
// Returns JSON status for all detection APIs.
// Protected by ADMIN_TOKEN.

module.exports = async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = {
    checkedAt: new Date().toISOString(),
    checks: {},
  };

  // Sightengine account check — uses account.json, no quota consumed
  try {
    const apiUser = process.env.SIGHTENGINE_API_USER;
    const apiSecret = process.env.SIGHTENGINE_API_SECRET;

    if (!apiUser || !apiSecret) {
      results.checks.sightengine = { status: 'skip', reason: 'Credentials not configured' };
    } else {
      const url = `https://api.sightengine.com/1.0/account.json?api_user=${encodeURIComponent(apiUser)}&api_secret=${encodeURIComponent(apiSecret)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();

      if (data.status === 'success') {
        results.checks.sightengine = {
          status: 'ok',
          plan: data.quota?.plan_name,
          creditsLeft: data.quota?.credits_left,
          creditsTotal: data.quota?.credits_total,
        };
      } else {
        results.checks.sightengine = {
          status: 'fail',
          error: data.error?.message || data.error || JSON.stringify(data),
        };
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
