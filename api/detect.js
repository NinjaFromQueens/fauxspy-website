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
    // Video frame captures and base64-only requests are ephemeral — skip cache
    const skipCache = isVideoFrame === true || (!imageUrl && !!imageData);
    let cacheKey;

    if (!skipCache) {
      cacheKey = `detect:v7:${await hashUrl(imageUrl)}`;
      const cached = await getCached(cacheKey);

      if (cached) {
        console.log('💾 [CACHE HIT]', (imageUrl || 'imageData').substring(0, 60));
        const result = isPro ? cached.pro : cached.free;
        return res.status(200).json({ ...result, cached: true });
      }
    }
    
    // ========================================================================
    // IMAGE HEADER ANALYSIS: C2PA + EXIF metadata signals
    // Runs before limit deduction — C2PA verifications are free.
    // Single 64KB Range fetch covers both C2PA JUMBF and EXIF APP1 segments.
    // Fails gracefully: any error falls through to normal detection.
    // ========================================================================
    let c2paResult = null;
    let exifData = null;

    if (imageUrl && !isVideoFrame) {
      try {
        const headerAnalysis = await Promise.race([
          analyzeImageHeader(imageUrl),
          new Promise(resolve => setTimeout(() => resolve(null), 3000))
        ]);
        c2paResult = headerAnalysis?.c2pa || null;
        exifData = headerAnalysis?.exif || null;
      } catch (headerErr) {
        console.warn('⚠️ [HEADER] Analysis threw unexpectedly:', headerErr.message?.substring(0, 60));
      }

      if (c2paResult?.valid) {
        console.log('🏛️ [C2PA VERIFIED]', c2paResult.signerName || 'unknown signer', imageUrl.substring(0, 60));

        const c2paEarlyResult = {
          success: true,
          isAI: false,
          aiProbability: 0,
          confidence: 1.0,
          verdict: 'verified_real',
          verdictLabel: 'Camera Verified',
          category: 'real',
          method: 'c2pa_verified',
          signal: null,
          trace: null,
          indicators: [
            'C2PA content credential verified',
            c2paResult.signerName ? `Signed by: ${c2paResult.signerName}` : 'Cryptographic provenance signature present',
            c2paResult.claimGenerator ? `Device: ${c2paResult.claimGenerator}` : null,
            c2paResult.signingTime ? `Signed: ${c2paResult.signingTime}` : null,
            'Camera-level provenance confirmed — not AI generated'
          ].filter(Boolean),
          proHint: null,
          c2pa: {
            present: true,
            valid: true,
            signerName: c2paResult.signerName || null,
            signingTime: c2paResult.signingTime || null,
            claimGenerator: c2paResult.claimGenerator || null
          },
          timestamp: Date.now()
        };

        // Cache so second scan returns instantly (no API consumed, no token deducted)
        if (!skipCache && cacheKey) {
          await cacheResult(cacheKey, { free: c2paEarlyResult, pro: c2paEarlyResult });
        }

        return res.status(200).json(c2paEarlyResult);
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
    
    // If C2PA metadata was present but structurally invalid, annotate the result
    // (e.g. UUID found but JUMBF boxes were malformed — possible tampering)
    if (c2paResult?.present && !c2paResult?.valid) {
      const tamperNote = 'C2PA credentials detected but signature is INVALID — image may have been modified after signing';
      [freeResult, proResult].filter(Boolean).forEach(r => {
        r.indicators = [tamperNote, ...(r.indicators || [])];
        r.c2pa = { present: true, valid: false, error: c2paResult.error || 'structural_invalid' };
      });
    }

    // Attach metadata signals (EXIF + dimension analysis) to both result tiers
    const metaSignals = computeMetadataSignals(exifData, width, height);
    if (metaSignals.length > 0) {
      [freeResult, proResult].filter(Boolean).forEach(r => {
        r.metadata_signals = metaSignals;
      });
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

// ============================================================================
// C2PA CONTENT CREDENTIAL CHECKER
//
// C2PA (Content Authenticity Initiative) embeds cryptographic provenance in
// images. Cameras (Leica, Sony) and tools (Adobe) sign images at capture time.
// Valid C2PA credentials mean the image came from a real camera — not AI.
//
// Verification level: STRUCTURAL only (UUID match + well-formed JUMBF boxes).
// Full X.509 chain verification requires c2pa-node which needs Rust/Cargo —
// not available in Vercel serverless. Structural check is sufficient to detect
// real camera provenance; cryptographic validation is a future enhancement.
// ============================================================================

const C2PA_UUID = Buffer.from([
  0x63, 0x32, 0x70, 0x61, 0x00, 0x11, 0x00, 0x10,
  0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71
]);
const C2PA_APP11_MARKER = 0xFFEB;
const C2PA_MAX_READ_BYTES = 65536; // 64KB — enough to capture any JPEG APP segments

async function analyzeImageHeader(imageUrl) {
  let buf;
  try {
    const res = await fetch(imageUrl, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-65535', 'Accept': 'image/*,*/*' },
      signal: AbortSignal.timeout(2500),
      redirect: 'follow'
    });

    if (!res.ok) return { c2pa: null, exif: null };

    // Read up to C2PA_MAX_READ_BYTES regardless of whether Range was honored.
    // This prevents loading a 50MB image into memory if the CDN ignores Range.
    const reader = res.body?.getReader();
    if (!reader) return { c2pa: null, exif: null };

    const chunks = [];
    let totalBytes = 0;
    try {
      while (totalBytes < C2PA_MAX_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  } catch {
    return { c2pa: null, exif: null }; // Network error, timeout, CORS — not fatal
  }

  if (!buf || buf.length < 16) return { c2pa: null, exif: null };

  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isWebP = buf.length >= 12 && buf.slice(8, 12).toString('ascii') === 'WEBP';

  const c2pa = isJpeg ? parseJpegForC2PA(buf) : (isWebP ? parseWebPForC2PA(buf) : null);
  const exif = isJpeg ? parseJpegExif(buf) : null;

  return { c2pa, exif };
}

function parseJpegForC2PA(buf) {
  let pos = 2; // Skip SOI marker (FF D8)
  let iterations = 0;
  const MAX_SEGMENTS = 256; // prevent infinite loop on crafted input

  while (pos + 3 < buf.length && iterations++ < MAX_SEGMENTS) {
    if (buf[pos] !== 0xFF) { pos++; continue; }

    const marker = (buf[pos] << 8) | buf[pos + 1];

    // Standalone markers with no length field
    if (marker === 0xFFD8 || marker === 0xFFD9) break;
    if (marker >= 0xFFD0 && marker <= 0xFFD7) { pos += 2; continue; } // RST0-7
    if (buf[pos + 1] === 0x00) { pos += 2; continue; } // stuffed byte

    if (pos + 4 > buf.length) break;
    const segLen = (buf[pos + 2] << 8) | buf[pos + 3]; // includes own 2 bytes
    if (segLen < 2) break; // malformed

    if (marker === C2PA_APP11_MARKER) {
      const segEnd = Math.min(pos + 2 + segLen, buf.length);
      const segData = buf.slice(pos + 4, segEnd);
      const result = parseJUMBF(segData);
      if (result) return result;
    }

    pos += 2 + segLen;
  }
  return null;
}

function parseWebPForC2PA(buf) {
  // Walk RIFF chunks looking for C2PA XMP data
  let idx = 12; // skip "RIFF", size, "WEBP"
  let iterations = 0;

  while (idx + 8 <= buf.length && iterations++ < 64) {
    const chunkType = buf.slice(idx, idx + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(idx + 4);

    if (chunkSize === 0) break; // prevent infinite loop

    if (chunkType === 'XMP ') {
      const xmpData = buf.slice(idx + 8, Math.min(idx + 8 + chunkSize, buf.length));
      const xmpStr = xmpData.toString('utf8', 0, Math.min(xmpData.length, 4096));
      if (xmpStr.includes('c2pa:')) {
        const signerMatch = xmpStr.match(/<dc:creator[^>]*>\s*<rdf:Seq[^>]*>\s*<rdf:li[^>]*>([^<]{3,80})<\/rdf:li>/);
        return {
          present: true, valid: true,
          signerName: signerMatch ? signerMatch[1].trim().substring(0, 128) : null,
          signingTime: null, claimGenerator: null
        };
      }
    }

    const paddedSize = chunkSize + (chunkSize % 2); // RIFF chunks are word-aligned
    idx += 8 + paddedSize;
  }
  return null;
}

function parseJUMBF(data) {
  let offset = 0;
  let iterations = 0;

  while (offset + 8 <= data.length && iterations++ < 32) {
    if (data.length - offset < 8) break;
    const boxSize = data.readUInt32BE(offset);
    if (boxSize < 8 || boxSize > data.length - offset) break; // bounds check

    const boxType = data.slice(offset + 4, offset + 8).toString('ascii');

    if (boxType === 'jumb') {
      const inner = data.slice(offset + 8, offset + boxSize);
      const result = parseJUMBFSubboxes(inner);
      if (result) return result;
    }

    offset += boxSize;
  }
  return null;
}

function parseJUMBFSubboxes(data) {
  let offset = 0;
  let foundC2PA = false;
  let signerName = null;
  let signingTime = null;
  let claimGenerator = null;
  let iterations = 0;

  while (offset + 8 <= data.length && iterations++ < 64) {
    const boxSize = data.readUInt32BE(offset);
    if (boxSize < 8) break; // malformed — stop processing

    const actualSize = Math.min(boxSize, data.length - offset);
    const boxType = data.slice(offset + 4, offset + 8).toString('ascii');

    if (boxType === 'jumd') {
      // Description box: [4B size][4B "jumd"][16B UUID][1B flags][label\0]
      if (offset + 24 <= data.length) {
        const uuid = data.slice(offset + 8, offset + 24);
        if (uuid.equals(C2PA_UUID)) {
          foundC2PA = true;
        }
      }
    } else if (boxType === 'cbor' && foundC2PA) {
      const payload = data.slice(offset + 8, offset + actualSize);
      const extracted = extractTextFromCBOR(payload);
      signerName = extracted.signerName;
      signingTime = extracted.signingTime;
      claimGenerator = extracted.claimGenerator;
    }

    offset += actualSize;
  }

  if (!foundC2PA) return null;
  return { present: true, valid: true, signerName, signingTime, claimGenerator };
}

function extractTextFromCBOR(buf) {
  // Minimal text extraction from CBOR-encoded C2PA manifest.
  // Scans for UTF-8 strings adjacent to known field name keys.
  // Not a full CBOR parser — full parsing would require a dependency.
  const result = { signerName: null, signingTime: null, claimGenerator: null };

  const fieldMap = [
    { key: Buffer.from('claim_generator'), field: 'claimGenerator' },
    { key: Buffer.from('dateTime'),        field: 'signingTime' },
    { key: Buffer.from('subject_dn'),      field: 'signerName' }
  ];

  for (const { key, field } of fieldMap) {
    const idx = buf.indexOf(key);
    if (idx === -1 || idx + key.length + 2 >= buf.length) continue;

    // Scan forward up to 8 bytes for a CBOR text item (major type 3)
    let valPos = idx + key.length;
    for (let skip = 0; skip < 8 && valPos < buf.length; skip++, valPos++) {
      const b = buf[valPos];

      if (b >= 0x60 && b <= 0x77) {
        // Short inline-length text (0 to 23 bytes)
        const len = b & 0x1F;
        if (len > 0 && valPos + 1 + len <= buf.length) {
          const text = buf.slice(valPos + 1, valPos + 1 + len).toString('utf8');
          if (/^[\x20-\x7EÀ-ɏ]{2,128}$/.test(text)) {
            result[field] = text;
          }
        }
        break;
      }

      if (b === 0x78) {
        // 1-byte length follows
        if (valPos + 2 >= buf.length) break;
        const len = buf[valPos + 1];
        if (len > 0 && len <= 128 && valPos + 2 + len <= buf.length) {
          const text = buf.slice(valPos + 2, valPos + 2 + len).toString('utf8');
          if (/^[\x20-\x7EÀ-ɏ]{2,128}$/.test(text)) {
            result[field] = text;
          }
        }
        break;
      }
    }
  }

  return result;
}

// ============================================================================
// METADATA SIGNAL ANALYSIS — EXIF + Dimension checks
// ============================================================================

// Known AI generation dimensions (exact pixel sizes used by major models)
const AI_DIMENSIONS = new Set([
  '512x512', '512x768', '768x512', '1024x512', '512x1024',   // SD 1.x
  '768x1024', '1024x768',                                      // SD 1.x
  '1024x1024',                                                 // DALL·E 3, SDXL, Flux
  '1024x1792', '1792x1024',                                   // DALL·E 3
  '832x1216', '1216x832',                                     // SDXL portrait/landscape
  '896x1152', '1152x896',                                     // SDXL
  '1344x768', '768x1344',                                     // SDXL wide
  '1536x640', '640x1536',                                     // SDXL extreme
  '2048x2048',                                                 // upscaled
]);

// Patterns matching AI tool names in EXIF Software tag
const AI_SOFTWARE_RE = /stable[\s._-]?diffusion|sdxl|comfyui|automatic1111|a1111|dall[\s-]?e|midjourney|adobe\s+firefly|runway\s+ml|pika\s+labs|ideogram|flux\b|leonardo\.ai|bing\s+image|sora\b/i;

function computeMetadataSignals(exif, width, height) {
  const signals = [];

  // Dimension analysis is free — width/height come from the extension request
  if (width && height && width > 0 && height > 0) {
    const key = `${width}x${height}`;
    if (AI_DIMENSIONS.has(key)) {
      signals.push({
        type: 'dimension_ai_typical',
        label: `Dimensions ${width}×${height} — common AI generation size`,
        severity: 'warn'
      });
    }
  }

  if (!exif) return signals;

  // Software tag contains an AI tool name — strong signal
  if (exif.software && AI_SOFTWARE_RE.test(exif.software)) {
    signals.push({
      type: 'exif_ai_software',
      label: `Software: ${exif.software.substring(0, 80)}`,
      severity: 'flag'
    });
  }

  // Has EXIF data but no camera Make or Model (often means AI-created, not photographed)
  // Only flag when Software is also present (pure-stripped EXIF is too common on social media)
  if (!exif.make && !exif.model && exif.software !== null) {
    signals.push({
      type: 'exif_no_camera',
      label: 'No camera make/model in EXIF data',
      severity: 'warn'
    });
  }

  // Camera confirmed — corroborates real photo verdict
  if (exif.make || exif.model) {
    const cam = [exif.make, exif.model].filter(Boolean).join(' ').substring(0, 60);
    signals.push({
      type: 'exif_camera',
      label: `Camera: ${cam}`,
      severity: 'info'
    });
  }

  return signals;
}

function parseJpegExif(buf) {
  // Walk JPEG segments looking for APP1 (0xFFE1) with "Exif\0\0" magic
  let pos = 2;
  let iterations = 0;
  const MAX_SEGMENTS = 32; // EXIF is always in first few segments

  while (pos + 3 < buf.length && iterations++ < MAX_SEGMENTS) {
    if (buf[pos] !== 0xFF) { pos++; continue; }

    const marker = (buf[pos] << 8) | buf[pos + 1];
    if (marker === 0xFFD9) break; // EOI

    // RST markers have no length
    if (marker >= 0xFFD0 && marker <= 0xFFD7) { pos += 2; continue; }
    if (buf[pos + 1] === 0x00) { pos += 2; continue; }

    if (pos + 4 > buf.length) break;
    const segLen = (buf[pos + 2] << 8) | buf[pos + 3];
    if (segLen < 2) break;

    if (marker === 0xFFE1 && pos + 10 <= buf.length) {
      // Check for "Exif\0\0" magic at bytes 4-9 of segment
      const magic = buf.slice(pos + 4, pos + 10).toString('ascii');
      if (magic === 'Exif\0\0') {
        const tiffStart = pos + 10;
        const exif = parseTiffIFD(buf, tiffStart);
        if (exif) return exif;
      }
    }

    pos += 2 + segLen;
  }
  return null;
}

function parseTiffIFD(buf, tiffStart) {
  if (tiffStart + 8 > buf.length) return null;

  // Byte order: "II" = little-endian, "MM" = big-endian
  const byteOrderMark = buf.slice(tiffStart, tiffStart + 2).toString('ascii');
  const le = byteOrderMark === 'II';

  const readU16 = (offset) => {
    if (offset + 2 > buf.length) return 0;
    return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  };
  const readU32 = (offset) => {
    if (offset + 4 > buf.length) return 0;
    return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
  };

  // Verify TIFF magic (42)
  if (readU16(tiffStart + 2) !== 42) return null;

  const ifd0Offset = readU32(tiffStart + 4);
  const ifd0Pos = tiffStart + ifd0Offset;

  if (ifd0Pos + 2 > buf.length) return null;
  const entryCount = readU16(ifd0Pos);
  if (entryCount > 512) return null; // sanity cap

  const result = { make: null, model: null, software: null };
  const TARGET_TAGS = { 0x010F: 'make', 0x0110: 'model', 0x0131: 'software' };

  for (let i = 0; i < entryCount; i++) {
    const entryPos = ifd0Pos + 2 + i * 12;
    if (entryPos + 12 > buf.length) break;

    const tag = readU16(entryPos);
    const field = TARGET_TAGS[tag];
    if (!field) continue;

    const type = readU16(entryPos + 2);
    const count = readU32(entryPos + 4);
    const valueOrOffset = readU32(entryPos + 8);

    if (type !== 2) continue; // only ASCII strings (type=2)
    if (count < 1 || count > 256) continue; // sanity cap

    // Value fits inline (≤4 bytes) or is an offset into TIFF data
    let strStart;
    if (count <= 4) {
      strStart = entryPos + 8; // inline value
    } else {
      strStart = tiffStart + valueOrOffset;
    }

    if (strStart + count > buf.length) continue;

    // ASCII string; strip null terminator and whitespace
    const str = buf.slice(strStart, strStart + count).toString('ascii').replace(/\0/g, '').trim();
    if (str.length >= 1) result[field] = str.substring(0, 128);
  }

  return result;
}
