// /api/detect-video.js
// Faux Spy Video Detection — Pro + Video tier only
// Calls Sightengine /video/check-sync.json with genai model
// Deducts 10 tokens per scan (subscription balance first, then top-up)

const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});

const VIDEO_TOKEN_COST = 10;
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const SIGHTENGINE_TIMEOUT_MS = 90_000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fauxspy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { videoUrl, userId, licenseKey } = req.body || {};

    // ── Input validation ────────────────────────────────────────────────────
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
    if (!userId)   return res.status(400).json({ error: 'userId required' });
    if (!licenseKey) {
      return res.status(403).json({
        error: 'PRO_VIDEO_REQUIRED',
        message: 'Video detection requires a Pro + Video subscription.',
        upgradeUrl: 'https://fauxspy.com/pro'
      });
    }

    try { new URL(videoUrl); } catch {
      return res.status(400).json({ error: 'Invalid videoUrl' });
    }

    if (videoUrl.startsWith('blob:') || videoUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Cannot analyze blob: or data: URLs' });
    }

    // ── License validation ──────────────────────────────────────────────────
    let licenseData;
    try {
      licenseData = await kv.get(`license:${licenseKey}`);
    } catch (err) {
      console.warn('⚠️ Could not fetch license:', err.message);
    }

    if (!licenseData) {
      return res.status(403).json({
        error: 'INVALID_LICENSE',
        message: 'License key not found or invalid.'
      });
    }

    if (licenseData.status !== 'active') {
      return res.status(403).json({
        error: 'LICENSE_INACTIVE',
        message: 'Your subscription is not active. Visit fauxspy.com/pro to renew.'
      });
    }

    // Check expiration with 3-day grace period
    const gracePeriodMs = 3 * 24 * 60 * 60 * 1000;
    if (licenseData.expiresAt && Date.now() > licenseData.expiresAt + gracePeriodMs) {
      return res.status(403).json({
        error: 'LICENSE_EXPIRED',
        message: 'Your subscription has expired. Renew at fauxspy.com/pro.'
      });
    }

    // Check video detection feature flag
    const hasVideoDetection = licenseData.plan?.startsWith('video');
    if (!hasVideoDetection) {
      return res.status(403).json({
        error: 'VIDEO_FEATURE_REQUIRED',
        message: 'Video detection requires Pro + Video. Upgrade at fauxspy.com/pro.',
        upgradeUrl: 'https://fauxspy.com/pro'
      });
    }

    // Check token balance
    const totalTokens = (licenseData.tokenBalance || 0) + (licenseData.topupBalance || 0);
    if (totalTokens < VIDEO_TOKEN_COST) {
      return res.status(402).json({
        error: 'TOKENS_EXHAUSTED',
        message: `Video detection costs ${VIDEO_TOKEN_COST} tokens. You have ${totalTokens}. Purchase more to continue.`,
        tokenBalance: licenseData.tokenBalance || 0,
        topupBalance: licenseData.topupBalance || 0,
        required: VIDEO_TOKEN_COST,
        buyUrl: 'https://fauxspy.com/buy-tokens'
      });
    }

    // ── Cache check ─────────────────────────────────────────────────────────
    const cacheKey = `detect-video:v1:${hashUrl(videoUrl)}`;
    let cached;
    try {
      cached = await kv.get(cacheKey);
    } catch { /* non-fatal */ }

    if (cached) {
      console.log('💾 [VIDEO CACHE HIT]', videoUrl.substring(0, 60));
      // Still deduct tokens for cached result (cost already paid, but fairness)
      // Actually: return cached result WITHOUT deducting tokens — same as image cache behavior
      return res.status(200).json({
        ...cached,
        cached: true,
        tokenBalance: licenseData.tokenBalance || 0,
        topupBalance: licenseData.topupBalance || 0
      });
    }

    // ── Rate limiting: 100 req/min per license key ──────────────────────────
    try {
      const rlKey = `ratelimit:detect-video:${licenseKey?.substring(0, 16)}`;
      const rlCount = await kv.incr(rlKey);
      if (rlCount === 1) await kv.expire(rlKey, 60);
      if (rlCount > 100) {
        return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please slow down.' });
      }
    } catch { /* non-fatal */ }

    // ── Sightengine credentials ─────────────────────────────────────────────
    const apiUser   = process.env.SIGHTENGINE_API_USER;
    const apiSecret = process.env.SIGHTENGINE_API_SECRET;

    if (!apiUser || !apiSecret) {
      return res.status(500).json({
        error: 'SERVER_NOT_CONFIGURED',
        message: 'Detection service unavailable. Please try again later.'
      });
    }

    // ── Call Sightengine video API ──────────────────────────────────────────
    console.log('🎬 [VIDEO DETECT]', videoUrl.substring(0, 80));

    const formData = new URLSearchParams({
      url:        videoUrl,
      models:     'genai',
      api_user:   apiUser,
      api_secret: apiSecret
    });

    let seResponse;
    try {
      seResponse = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    formData.toString(),
        signal:  AbortSignal.timeout(SIGHTENGINE_TIMEOUT_MS)
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'TimeoutError') {
        return res.status(504).json({
          error: 'DETECTION_TIMEOUT',
          message: 'Video analysis timed out. Try a shorter video or try again.'
        });
      }
      throw fetchErr;
    }

    const seData = await seResponse.json();

    if (seData.status === 'failure') {
      console.error('❌ [SIGHTENGINE VIDEO]', seData.error);

      if (seData.error?.type?.includes('quota') || seData.error?.type?.includes('limit')) {
        return res.status(503).json({
          error: 'SERVICE_BUSY',
          message: 'Detection service is busy. Please try again in a few minutes.'
        });
      }

      return res.status(500).json({
        error: 'DETECTION_FAILED',
        message: seData.error?.message || 'Video detection failed'
      });
    }

    // ── Parse frames ────────────────────────────────────────────────────────
    const frames = seData.output?.frames || [];

    if (frames.length === 0) {
      return res.status(500).json({
        error: 'NO_FRAMES',
        message: 'Video could not be processed. It may be too short or in an unsupported format.'
      });
    }

    // Average AI score across all frames
    const avgAiScore = frames.reduce((sum, f) => sum + (f.ai_generated?.score ?? 0), 0) / frames.length;

    // Find top generator across all frames (sum scores per generator)
    const generatorTotals = {};
    for (const frame of frames) {
      const scores = frame.ai_generated?.scores || {};
      for (const [gen, score] of Object.entries(scores)) {
        generatorTotals[gen] = (generatorTotals[gen] || 0) + score;
      }
    }
    const topGenerator = Object.entries(generatorTotals)
      .sort((a, b) => b[1] - a[1])[0] || null;
    const topGeneratorName   = topGenerator ? topGenerator[0] : null;
    const topGeneratorScore  = topGenerator ? topGenerator[1] / frames.length : 0;

    // ── Verdict ─────────────────────────────────────────────────────────────
    const verdict = getVideoVerdict(avgAiScore);

    const result = {
      success:          true,
      isAIVideo:        verdict.isAI,
      aiScore:          avgAiScore,
      verdict:          verdict.tier,
      verdictLabel:     verdict.label,
      framesAnalyzed:   frames.length,
      topGenerator:     topGeneratorName,
      topGeneratorScore: parseFloat(topGeneratorScore.toFixed(3)),
      duration:         seData.output?.duration ?? null,
      method:           'sightengine_video_api',
      timestamp:        Date.now()
    };

    // ── Cache result ────────────────────────────────────────────────────────
    try {
      await kv.set(cacheKey, result, { ex: CACHE_TTL_SECONDS });
    } catch (err) {
      console.warn('⚠️ Cache write failed:', err.message);
    }

    // ── Deduct tokens ───────────────────────────────────────────────────────
    try {
      let remaining = VIDEO_TOKEN_COST;
      if (licenseData.tokenBalance >= remaining) {
        licenseData.tokenBalance -= remaining;
      } else {
        remaining -= licenseData.tokenBalance;
        licenseData.tokenBalance = 0;
        licenseData.topupBalance = Math.max(0, (licenseData.topupBalance || 0) - remaining);
      }
      await kv.set(`license:${licenseKey}`, licenseData);
    } catch (err) {
      console.warn('⚠️ Token deduction failed:', err.message);
      // Non-fatal — scan already completed
    }

    console.log(`✅ [VIDEO RESULT] ${result.verdictLabel} (${(avgAiScore * 100).toFixed(1)}%) — top generator: ${topGeneratorName || 'none'}`);

    return res.status(200).json({
      ...result,
      tokenBalance: licenseData.tokenBalance,
      topupBalance: licenseData.topupBalance,
      tokensUsed: VIDEO_TOKEN_COST
    });

  } catch (error) {
    console.error('❌ [DETECT-VIDEO ERROR]', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.'
    });
  }
};

// ============================================================================
// VERDICT
// ============================================================================

function getVideoVerdict(score) {
  if (score >= 0.65) {
    return {
      tier:   'ai_video',
      label:  'AI Generated Video',
      isAI:   true
    };
  }
  if (score >= 0.40) {
    return {
      tier:   'inconclusive',
      label:  'Inconclusive',
      isAI:   false
    };
  }
  return {
    tier:   'real_video',
    label:  'Likely Real Video',
    isAI:   false
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
