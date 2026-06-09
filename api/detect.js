// /api/detect.js
// Faux Spy Detection Proxy v6 - Pro tier gets 5 categories, Free tier gets 3
// Free: Real / Inconclusive / AI (genai model only)
// Pro: Real / Digital Art / Inconclusive / AI Art / AI Photo (genai + type models)

const { Redis } = require('@upstash/redis');
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN_BACKEND) {
  Sentry.init({ dsn: process.env.SENTRY_DSN_BACKEND, tracesSampleRate: 0 });
}

const kv = new Redis({
  url: process.env.UPSTASH_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN,
});
const licenseKv = kv;

const FREE_TIER_DAILY_LIMIT = 10;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const USAGE_TTL_SECONDS = 25 * 60 * 60; // 25 hours

// In-memory fallbacks
const inMemoryUsage = new Map();
const inMemoryCache = new Map();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    let { imageUrl, imageData, userId, isPro, licenseKey, width, height, isVideoFrame } = req.body || {};

    if (!imageUrl && !imageData) return res.status(400).json({ error: 'imageUrl or imageData required' });
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // URL validation only applies when a URL is provided (not for base64 frame captures)
    if (imageUrl) {
      try {
        new URL(imageUrl);
      } catch {
        return res.status(400).json({ error: 'Invalid imageUrl' });
      }
      if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
        return res.status(400).json({ error: 'Cannot analyze data: or blob: URLs' });
      }
    }

    // Resolve redirect chains before calling Sightengine (fixes CDN 3xx errors, e.g. Instagram/Facebook)
    if (imageUrl) {
      try {
        const headRes = await fetch(imageUrl, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(3000)
        });
        if (headRes.url && headRes.url !== imageUrl) {
          console.log('↪️ [REDIRECT]', imageUrl.substring(0, 60), '→', headRes.url.substring(0, 60));
          imageUrl = headRes.url;
        }
      } catch {
        // HEAD failed — proceed with original URL
      }
    }

    // Image dimension pre-check
    if (width && height && (width < 100 || height < 100)) {
      return res.status(200).json({
        success: true,
        isAI: false,
        aiProbability: 0,
        verdict: 'insufficient_data',
        verdictLabel: 'Image Too Small',
        category: 'insufficient_data',
        indicators: [
          `Image is ${width}×${height} pixels`,
          'Detection requires images at least 100×100 pixels',
          'Try a larger version of this image'
        ],
        method: 'pre_check_failed'
      });
    }
    
    // ========================================================================
    // STEP 1: Check cache (stores BOTH free and pro responses)
    // ========================================================================
    // Video frame captures are ephemeral — skip cache entirely
    const skipCache = isVideoFrame === true;
    let cacheKey;

    if (!skipCache) {
      cacheKey = `detect:v7:${await hashUrl(imageUrl)}`;
      const cached = await getCached(cacheKey);

      if (cached) {
        console.log('💾 [CACHE HIT]', imageUrl.substring(0, 60));
        const result = isPro ? cached.pro : cached.free;
        return res.status(200).json({ ...result, cached: true });
      }
    }
    
    // ========================================================================
    // STEP 2: Daily limit check (free tier) or token check (pro tier)
    // ========================================================================
    let proLicenseData = null;

    if (!isPro) {
      const usage = await getUserUsage(userId);

      if (usage >= FREE_TIER_DAILY_LIMIT) {
        return res.status(429).json({
          error: 'DAILY_LIMIT_REACHED',
          message: `Free tier limit reached (${FREE_TIER_DAILY_LIMIT}/day).`,
          used: usage,
          limit: FREE_TIER_DAILY_LIMIT,
          upgradeUrl: 'https://fauxspy.com/pro'
        });
      }
    } else if (licenseKey) {
      // Pro: check token balance
      try {
        proLicenseData = await licenseKv.get(`license:${licenseKey}`);
      } catch (err) {
        console.warn('⚠️ Could not fetch license for token check:', err.message);
      }

      if (!proLicenseData) {
        console.warn('⚠️ Pro scan with unresolved license key:', licenseKey?.substring(0, 12));
      }

      if (proLicenseData) {
        const available = (proLicenseData.tokenBalance || 0) + (proLicenseData.topupBalance || 0);
        if (available <= 0) {
          return res.status(402).json({
            error: 'TOKENS_EXHAUSTED',
            message: 'You have used all your tokens. Purchase more to continue scanning.',
            tokenBalance: 0,
            topupBalance: 0,
            buyUrl: 'https://fauxspy.com/buy-tokens'
          });
        }
      }
    }
    
    // ========================================================================
    // STEP 3: Validate provider credentials
    // SIGNAL = Hive Moderation (primary AI detection)
    // TRACE  = Sightengine (illustration type + deepfake + genai fallback)
    // ========================================================================
    const hiveApiKey = process.env.HIVE_API_KEY;
    const apiUser = process.env.SIGHTENGINE_API_USER;
    const apiSecret = process.env.SIGHTENGINE_API_SECRET;

    if (!hiveApiKey && (!apiUser || !apiSecret)) {
      console.error('❌ No detection provider configured (need HIVE_API_KEY or Sightengine credentials)');
      return res.status(500).json({
        error: 'SERVER_NOT_CONFIGURED',
        message: 'Detection service unavailable. Please try again later.'
      });
    }

    // ========================================================================
    // STEP 4: Call SIGNAL (Hive) + TRACE (Sightengine) in parallel
    // SIGNAL provides the primary AI probability (higher accuracy on new models)
    // TRACE provides illustration type, deepfake score, and genai fallback
    // ========================================================================
    const sightengineModels = isPro ? 'genai,type,deepfake' : 'genai,type';

    async function callSignal() {
      if (!hiveApiKey) throw new Error('HIVE_API_KEY not configured');
      let hiveRes;
      if (imageData) {
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        const form = new FormData();
        form.append('media', blob, 'frame.jpg');
        console.log(`🎬 [SIGNAL ${isPro ? 'PRO' : 'FREE'}] ${buffer.length} bytes`);
        hiveRes = await fetch('https://api.thehive.ai/api/v2/task/sync', {
          method: 'POST',
          headers: { 'Authorization': `Token ${hiveApiKey}` },
          body: form,
          signal: AbortSignal.timeout(15000)
        });
      } else {
        console.log(`🔍 [SIGNAL ${isPro ? 'PRO' : 'FREE'}]`, imageUrl.substring(0, 80));
        hiveRes = await fetch('https://api.thehive.ai/api/v2/task/sync', {
          method: 'POST',
          headers: { 'Authorization': `Token ${hiveApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: imageUrl }),
          signal: AbortSignal.timeout(10000)
        });
      }
      const hiveData = await hiveRes.json();
      const classes = hiveData.status?.[0]?.response?.output?.[0]?.classes;
      const score = classes?.find(c => c.class === 'ai_generated')?.score;
      if (typeof score !== 'number') throw new Error(`Hive unexpected response: ${JSON.stringify(hiveData).substring(0, 200)}`);
      return score;
    }

    async function callTrace() {
      if (!apiUser || !apiSecret) throw new Error('Sightengine credentials not configured');
      let traceData;
      if (imageData) {
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        const form = new FormData();
        form.append('media', blob, 'frame.jpg');
        form.append('models', sightengineModels);
        form.append('api_user', apiUser);
        form.append('api_secret', apiSecret);
        console.log(`🎬 [TRACE ${isPro ? 'PRO' : 'FREE'}] ${buffer.length} bytes`);
        const r = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: form });
        traceData = await r.json();
      } else {
        const params = new URLSearchParams({ url: imageUrl, models: sightengineModels, api_user: apiUser, api_secret: apiSecret });
        console.log(`🔍 [TRACE ${isPro ? 'PRO' : 'FREE'}]`, imageUrl.substring(0, 80));
        const r = await fetch(`https://api.sightengine.com/1.0/check.json?${params.toString()}`, { headers: { 'Accept': 'application/json' } });
        traceData = await r.json();
      }
      if (traceData.status === 'failure') {
        if (traceData.error?.type?.includes('quota') || traceData.error?.type?.includes('limit')) {
          throw new Error(`Sightengine quota: ${traceData.error?.message}`);
        }
        Sentry.captureEvent({
          message: `TRACE (Sightengine) failure: code ${traceData.error?.code}`,
          level: 'error',
          tags: { se_code: String(traceData.error?.code || 'unknown'), is_pro: String(isPro) },
          extra: { seError: traceData.error, urlPattern: imageUrl ? imageUrl.substring(0, 80) : null }
        });
        throw new Error(`Sightengine error ${traceData.error?.code}: ${traceData.error?.message}`);
      }
      return {
        genaiScore: traceData.type?.ai_generated ?? null,
        illustrationScore: traceData.type?.illustration ?? 0,
        photoScore: traceData.type?.photo ?? 0,
        deepfakeScore: isPro ? (typeof traceData.deepfake === 'number' ? traceData.deepfake : 0) : 0
      };
    }

    const [signalResult, traceResult] = await Promise.allSettled([callSignal(), callTrace()]);

    // Resolve aiProbability: SIGNAL (Hive) primary, TRACE genai fallback
    let aiProbability;
    let signalStatus;

    if (signalResult.status === 'fulfilled') {
      aiProbability = signalResult.value;
      signalStatus = 'ok';
    } else {
      console.warn('⚠️ [SIGNAL/Hive failed]', signalResult.reason?.message);
      Sentry.captureEvent({
        message: `SIGNAL (Hive) failed: ${signalResult.reason?.message}`,
        level: 'warning',
        tags: { is_pro: String(isPro) }
      });
      if (traceResult.status === 'fulfilled' && typeof traceResult.value.genaiScore === 'number') {
        aiProbability = traceResult.value.genaiScore;
        signalStatus = 'fallback';
      } else {
        return res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          message: 'Detection service temporarily unavailable. Please try again.'
        });
      }
    }

    // Resolve TRACE scores (illustration, deepfake)
    let illustrationScore = 0, photoScore = 0, deepfakeScore = 0;
    let traceStatus;
    let traceScores = null;

    if (traceResult.status === 'fulfilled') {
      illustrationScore = traceResult.value.illustrationScore;
      photoScore = traceResult.value.photoScore;
      deepfakeScore = traceResult.value.deepfakeScore;
      traceStatus = 'ok';
      traceScores = traceResult.value;
    } else {
      console.warn('⚠️ [TRACE/Sightengine failed]', traceResult.reason?.message);
      traceStatus = 'failed';
    }

    if (typeof aiProbability !== 'number') {
      console.error('❌ No valid AI probability from either provider');
      return res.status(500).json({
        error: 'INVALID_RESPONSE',
        message: 'Detection returned unexpected format'
      });
    }

    // Method string for client transparency
    const detectionMethod = signalStatus === 'ok' && traceStatus === 'ok' ? 'signal_trace'
      : signalStatus === 'ok' ? 'signal_only'
      : traceStatus === 'ok' ? 'trace_full'
      : 'unknown';

    // SIGNAL + TRACE metadata for client display
    const signalMeta = {
      name: 'SIGNAL',
      score: signalStatus === 'ok' ? signalResult.value : null,
      status: signalStatus
    };
    const traceMeta = traceScores ? {
      name: 'TRACE',
      illustrationScore: traceScores.illustrationScore,
      photoScore: traceScores.photoScore,
      ...(isPro ? { deepfakeScore: traceScores.deepfakeScore } : {}),
      status: 'ok'
    } : { name: 'TRACE', status: 'failed' };
    
    // ========================================================================
    // STEP 5: Build BOTH free and pro verdict objects (for caching)
    // ========================================================================
    
    // Free tier: 4-category verdict (genai + type)
    const freeVerdict = getFreeTierVerdict(aiProbability, illustrationScore);
    const freeResult = {
      success: true,
      isAI: freeVerdict.tier === 'likely_ai' || freeVerdict.tier === 'definitely_ai',
      aiProbability,
      confidence: aiProbability,
      verdict: freeVerdict.tier,
      verdictLabel: freeVerdict.label,
      category: freeVerdict.category,
      method: detectionMethod,
      signal: signalMeta,
      trace: traceMeta,
      indicators: freeVerdict.indicators,
      // Hint about Pro tier capability
      proHint: freeVerdict.proHint,
      timestamp: Date.now()
    };
    
    let proResult = null;
    if (isPro) {
      // Pro tier: 5-category verdict (genai + type)
      const proVerdict = getProTierVerdict(aiProbability, illustrationScore, deepfakeScore);
      proResult = {
        success: true,
        isAI: proVerdict.tier === 'likely_ai' || proVerdict.tier === 'definitely_ai' || proVerdict.tier === 'likely_ai_art',
        aiProbability,
        illustrationScore,
        photoScore,
        deepfakeScore,
        confidence: aiProbability,
        verdict: proVerdict.tier,
        verdictLabel: proVerdict.label,
        category: proVerdict.category,
        method: detectionMethod,
        signal: signalMeta,
        trace: traceMeta,
        indicators: proVerdict.indicators,
        timestamp: Date.now()
      };
    }
    
    // ========================================================================
    // STEP 6: Cache BOTH versions (skip for video frame captures — frames are ephemeral)
    // ========================================================================
    if (!skipCache && cacheKey) {
      if (proResult) {
        await cacheResult(cacheKey, { free: freeResult, pro: proResult });
      } else {
        await cacheResult(cacheKey, { free: freeResult, pro: null });
      }
    }
    
    if (!isPro) {
      await incrementUserUsage(userId);
    } else if (licenseKey && proLicenseData) {
      // Deduct 1 token — subscription balance first, then top-up
      try {
        if (proLicenseData.tokenBalance > 0) {
          proLicenseData.tokenBalance -= 1;
        } else if (proLicenseData.topupBalance > 0) {
          proLicenseData.topupBalance -= 1;
        }
        await licenseKv.set(`license:${licenseKey}`, proLicenseData);
      } catch (err) {
        console.warn('⚠️ Token deduction failed:', err.message);
        // Non-fatal — scan already completed
      }
    }

    const returnedResult = isPro ? proResult : freeResult;
    console.log(`✅ [RESULT/${detectionMethod}] ${returnedResult.verdictLabel} (SIGNAL: ${(aiProbability * 100).toFixed(1)}%${traceStatus === 'ok' ? `, Illust: ${(illustrationScore * 100).toFixed(1)}%` : ''})`);

    // Include token balance in Pro response so extension can sync
    const tokenInfo = (isPro && proLicenseData) ? {
      tokenBalance: proLicenseData.tokenBalance,
      topupBalance: proLicenseData.topupBalance,
    } : {};

    return res.status(200).json({ ...returnedResult, ...tokenInfo });
    
  } catch (error) {
    console.error('❌ [DETECT ERROR]', error);
    Sentry.captureException(error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.'
    });
  }
};

// ============================================================================
// FREE TIER VERDICT SYSTEM (4 categories)
// AI score + illustration score → Real / Digital Art / Inconclusive / AI
// ============================================================================

function getFreeTierVerdict(score, illustrationScore) {
  const aiPercent = (score * 100).toFixed(1);
  const realPercent = (100 - score * 100).toFixed(1);
  const isIllustration = (illustrationScore ?? 0) >= 0.50;

  // Definitely AI (85%+) — even stylized art at this score is AI-generated
  if (score >= 0.85) {
    return {
      tier: 'definitely_ai',
      label: 'Definitely Faux',
      category: 'ai',
      indicators: [
        `AI confidence: ${aiPercent}%`,
        'Strong AI generation signals detected'
      ],
      proHint: 'Pro identifies the exact AI generator used'
    };
  }

  // Likely AI (65-85%)
  if (score >= 0.65) {
    return {
      tier: 'likely_ai',
      label: 'Likely Faux',
      category: 'ai',
      indicators: [
        `AI confidence: ${aiPercent}%`,
        'AI generation patterns detected'
      ],
      proHint: 'Pro detects whether this is AI photo or AI art'
    };
  }

  // Digital Art — illustration score ≥ 0.50 with low-to-medium AI confidence
  // This catches human-made paintings, game art, illustrations, 3D renders
  if (isIllustration) {
    return {
      tier: 'digital_art',
      label: 'Digital Art',
      category: 'digital_art',
      indicators: [
        'This appears to be digital art or an illustration',
        'Could be: painting, game art, comic, 3D render, or animation frame',
        score >= 0.40 ? '⚠️ Has some AI signals — could be AI-assisted art' : 'Low AI signals — likely human-made'
      ],
      proHint: 'Pro confirms whether this is human-made or AI-generated art'
    };
  }

  // Inconclusive (40-65%) — not illustration, uncertain photo zone
  if (score >= 0.40) {
    return {
      tier: 'inconclusive',
      label: 'Inconclusive',
      category: 'inconclusive',
      indicators: [
        `Score: ${aiPercent}% AI / ${realPercent}% real`,
        '⚠️ Image is in the uncertain detection zone',
        'Could be: heavily filtered photo or low-confidence AI'
      ],
      proHint: 'Pro gives a definitive verdict with detailed breakdown'
    };
  }

  // Likely Real (20-40%)
  if (score >= 0.20) {
    return {
      tier: 'likely_real',
      label: 'No AI Detected',
      category: 'real',
      indicators: [
        `Real confidence: ${realPercent}%`,
        'No AI generation detected in this image',
        'ℹ️ Note: Photo manipulation (face swaps, body composites, Photoshop edits) can evade AI detectors — trust your instincts'
      ],
      proHint: null
    };
  }

  // Verified Real (0-20%)
  return {
    tier: 'verified_real',
    label: 'No AI Detected',
    category: 'real',
    indicators: [
      `Real confidence: ${realPercent}%`,
      'No AI generation signals found',
      'ℹ️ Note: Photo manipulation (face swaps, body composites, Photoshop edits) can evade AI detectors — trust your instincts'
    ],
    proHint: null
  };
}

// ============================================================================
// PRO TIER VERDICT SYSTEM (5 categories)
// AI score + illustration score → 5 distinct categories
// ============================================================================
//
// Decision matrix:
// AI < 0.40, illustration < 0.50 → Real photograph
// AI < 0.40, illustration >= 0.50 → Digital art (human-made illustration)
// AI 0.40-0.65, illustration < 0.50 → Inconclusive (uncertain photo)
// AI 0.40-0.65, illustration >= 0.50 → Digital art (slight AI signal but stylized)
// AI >= 0.65, illustration < 0.50 → AI Photo (photorealistic AI)
// AI >= 0.65, illustration >= 0.50 → AI Art (Midjourney-style)
//
// Edge case threshold: 0.50 for illustration is the natural midpoint
// (Sightengine returns illustration + photo = 1.0)
// ============================================================================

function getProTierVerdict(aiScore, illustrationScore, deepfakeScore = 0) {
  const aiPercent = (aiScore * 100).toFixed(1);
  const realPercent = (100 - aiScore * 100).toFixed(1);
  const illustPercent = (illustrationScore * 100).toFixed(1);
  const isIllustration = illustrationScore >= 0.50;
  
  // ============================================
  // HIGH AI CONFIDENCE (65%+) → AI Photo or AI Art
  // ============================================
  if (aiScore >= 0.85) {
    if (isIllustration) {
      return {
        tier: 'definitely_ai_art',
        label: 'AI Art (Confirmed)',
        category: 'ai_art',
        indicators: [
          `AI confidence: ${aiPercent}%`,
          `Illustration confidence: ${illustPercent}%`,
          'This appears to be AI-generated digital art',
          'Likely from: Midjourney, Stable Diffusion, DALL-E (artistic style)'
        ]
      };
    } else {
      return {
        tier: 'definitely_ai',
        label: 'AI Photo (Confirmed)',
        category: 'ai_photo',
        indicators: [
          `AI confidence: ${aiPercent}%`,
          'This appears to be a photorealistic AI-generated image',
          'Likely from: Midjourney v6, Flux, Imagen (photo mode)'
        ]
      };
    }
  }
  
  if (aiScore >= 0.65) {
    if (isIllustration) {
      return {
        tier: 'likely_ai_art',
        label: 'Likely AI Art',
        category: 'ai_art',
        indicators: [
          `AI confidence: ${aiPercent}%`,
          `Illustration confidence: ${illustPercent}%`,
          'Appears to be AI-generated stylized art'
        ]
      };
    } else {
      return {
        tier: 'likely_ai',
        label: 'Likely AI Photo',
        category: 'ai_photo',
        indicators: [
          `AI confidence: ${aiPercent}%`,
          'Appears to be photorealistic AI generation'
        ]
      };
    }
  }
  
  // ============================================
  // INCONCLUSIVE ZONE (40-65% AI)
  // For illustrations, lean toward "Digital Art" (human-made)
  // Reasoning: AI score in 40-65% on something stylized is more likely a human digital painting
  // ============================================
  if (aiScore >= 0.40) {
    if (isIllustration) {
      return {
        tier: 'digital_art_uncertain',
        label: 'Digital Art (Possibly AI)',
        category: 'digital_art',
        indicators: [
          `AI confidence: ${aiPercent}%`,
          `Illustration confidence: ${illustPercent}%`,
          'This is digital art (painting, drawing, render, or game art)',
          '⚠️ Has some AI signals but not conclusive'
        ]
      };
    } else {
      return {
        tier: 'inconclusive',
        label: 'Inconclusive',
        category: 'inconclusive',
        indicators: [
          `Score: ${aiPercent}% AI / ${realPercent}% real`,
          'Photo-like image in uncertain detection zone',
          'Could be: heavily filtered photo or AI-edited real image'
        ]
      };
    }
  }
  
  // ============================================
  // LOW AI CONFIDENCE (<40%) → Real or Digital Art
  // ============================================
  if (aiScore >= 0.20) {
    if (isIllustration) {
      return {
        tier: 'digital_art',
        label: 'Digital Art / Illustration',
        category: 'digital_art',
        indicators: [
          `Real confidence: ${realPercent}%`,
          `Illustration confidence: ${illustPercent}%`,
          'Human-made digital art (painting, drawing, render)',
          'Could be: Photoshop painting, 3D render, cartoon, game asset'
        ]
      };
    } else {
      const isManipulated = deepfakeScore > 0.50;
      const manipNote = isManipulated
        ? `⚠️ Possible face/body manipulation detected (${(deepfakeScore * 100).toFixed(0)}% confidence) — this may be a head swap or composite`
        : 'ℹ️ Note: Photo manipulation (face swaps, body composites, Photoshop edits) can evade AI detectors — trust your instincts';
      return {
        tier: isManipulated ? 'likely_real_manipulated' : 'likely_real',
        label: isManipulated ? 'Possible Manipulation' : 'No AI Detected',
        category: isManipulated ? 'manipulated' : 'real',
        indicators: [
          `Real confidence: ${realPercent}%`,
          'No AI generation detected in this image',
          manipNote
        ]
      };
    }
  }

  // Highest confidence real (0-20%)
  if (isIllustration) {
    return {
      tier: 'digital_art_verified',
      label: 'Digital Art (Verified)',
      category: 'digital_art',
      indicators: [
        `Real confidence: ${realPercent}%`,
        `Illustration confidence: ${illustPercent}%`,
        'Confirmed: human-made digital art',
        'Could be: traditional painting, digital illustration, 3D render, cartoon, game art'
      ]
    };
  } else {
    const isManipulated = deepfakeScore > 0.50;
    const manipNote = isManipulated
      ? `⚠️ Possible face/body manipulation detected (${(deepfakeScore * 100).toFixed(0)}% confidence) — this may be a head swap or composite`
      : 'ℹ️ Note: Photo manipulation (face swaps, body composites, Photoshop edits) can evade AI detectors — trust your instincts';
    return {
      tier: isManipulated ? 'verified_real_manipulated' : 'verified_real',
      label: isManipulated ? 'Possible Manipulation' : 'No AI Detected',
      category: isManipulated ? 'manipulated' : 'real',
      indicators: [
        `Real confidence: ${realPercent}%`,
        'No AI generation signals found',
        manipNote
      ]
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ============================================================================
// STORAGE: User usage (KV with in-memory fallback)
// ============================================================================

async function getUserUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `usage:${userId}:${today}`;
  
  try {
    const usage = await kv.get(key);
    return usage || 0;
  } catch (kvError) {
    const memUsage = inMemoryUsage.get(key);
    return memUsage?.count || 0;
  }
}

async function incrementUserUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `usage:${userId}:${today}`;
  
  try {
    const newCount = await kv.incr(key);
    if (newCount === 1) await kv.expire(key, USAGE_TTL_SECONDS);
  } catch (kvError) {
    const current = inMemoryUsage.get(key) || { date: today, count: 0 };
    current.count += 1;
    inMemoryUsage.set(key, current);
  }
}

// ============================================================================
// STORAGE: Result caching (KV with in-memory fallback)
// Cache stores { free, pro } object so both tiers can hit cache
// ============================================================================

async function getCached(cacheKey) {
  try {
    return await kv.get(cacheKey);
  } catch (kvError) {
    const cached = inMemoryCache.get(cacheKey);
    if (!cached) return null;
    
    const ageMs = Date.now() - cached.timestamp;
    const expirationMs = CACHE_TTL_SECONDS * 1000;
    
    if (ageMs > expirationMs) {
      inMemoryCache.delete(cacheKey);
      return null;
    }
    
    return cached.data;
  }
}

async function cacheResult(cacheKey, data) {
  try {
    await kv.set(cacheKey, data, { ex: CACHE_TTL_SECONDS });
  } catch (kvError) {
    inMemoryCache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });
    
    if (inMemoryCache.size > 10000) {
      const entries = Array.from(inMemoryCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < 1000; i++) {
        inMemoryCache.delete(entries[i][0]);
      }
    }
  }
}
