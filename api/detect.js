// /api/detect.js
// Faux Spy Detection Proxy v6 - Pro tier gets 5 categories, Free tier gets 3
// Free: Real / Inconclusive / AI (genai model only)
// Pro: Real / Digital Art / Inconclusive / AI Art / AI Photo (genai + type models)

const { kv } = require('@vercel/kv');

const FREE_TIER_DAILY_LIMIT = 20;
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
    const { imageUrl, userId, isPro, width, height } = req.body || {};
    
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    try {
      new URL(imageUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid imageUrl' });
    }
    
    if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
      return res.status(400).json({ error: 'Cannot analyze data: or blob: URLs' });
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
    const cacheKey = `detect:v6:${await hashUrl(imageUrl)}`;
    const cached = await getCached(cacheKey);
    
    if (cached) {
      console.log('💾 [CACHE HIT]', imageUrl.substring(0, 60));
      
      // Return appropriate version based on Pro status
      const result = isPro ? cached.pro : cached.free;
      return res.status(200).json({
        ...result,
        cached: true
      });
    }
    
    // ========================================================================
    // STEP 2: Daily limit check (free tier only)
    // ========================================================================
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
    }
    
    // ========================================================================
    // STEP 3: Validate Sightengine credentials
    // ========================================================================
    const apiUser = process.env.SIGHTENGINE_API_USER;
    const apiSecret = process.env.SIGHTENGINE_API_SECRET;
    
    if (!apiUser || !apiSecret) {
      console.error('❌ Sightengine credentials not configured');
      return res.status(500).json({
        error: 'SERVER_NOT_CONFIGURED',
        message: 'Detection service unavailable. Please try again later.'
      });
    }
    
    // ========================================================================
    // STEP 4: Call Sightengine
    // - Free: just genai model (1 operation)
    // - Pro: genai + type models (2 operations, but combined call)
    // ========================================================================
    const models = isPro ? 'genai,type' : 'genai';
    console.log(`🔍 [DETECT ${isPro ? 'PRO' : 'FREE'}]`, imageUrl.substring(0, 80));
    
    const params = new URLSearchParams({
      url: imageUrl,
      models,
      api_user: apiUser,
      api_secret: apiSecret
    });
    
    const sightengineUrl = `https://api.sightengine.com/1.0/check.json?${params.toString()}`;
    
    const response = await fetch(sightengineUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    const data = await response.json();
    
    if (data.status === 'failure') {
      console.error('❌ [SIGHTENGINE]', data.error);
      
      if (data.error?.type?.includes('quota') || data.error?.type?.includes('limit')) {
        return res.status(503).json({
          error: 'SERVICE_BUSY',
          message: 'Detection service is busy. Please try again in a few minutes.'
        });
      }
      
      return res.status(500).json({
        error: 'DETECTION_FAILED',
        message: data.error?.message || 'Detection failed'
      });
    }
    
    // Extract scores
    const aiProbability = data.type?.ai_generated;
    
    if (typeof aiProbability !== 'number') {
      console.error('❌ Unexpected response:', data);
      return res.status(500).json({
        error: 'INVALID_RESPONSE',
        message: 'Detection returned unexpected format'
      });
    }
    
    // For Pro: extract type scores
    // type.illustration: 0-1, where 1 = illustration, 0 = photograph
    const illustrationScore = isPro ? (data.type?.illustration ?? 0) : null;
    const photoScore = isPro ? (data.type?.photo ?? 0) : null;
    
    // ========================================================================
    // STEP 5: Build BOTH free and pro verdict objects (for caching)
    // ========================================================================
    
    // Free tier: 3-category verdict (genai only)
    const freeVerdict = getFreeTierVerdict(aiProbability);
    const freeResult = {
      success: true,
      isAI: freeVerdict.tier === 'likely_ai' || freeVerdict.tier === 'definitely_ai',
      aiProbability,
      confidence: aiProbability,
      verdict: freeVerdict.tier,
      verdictLabel: freeVerdict.label,
      category: freeVerdict.category,
      method: 'sightengine_api',
      indicators: freeVerdict.indicators,
      // Hint about Pro tier capability
      proHint: freeVerdict.proHint,
      timestamp: Date.now()
    };
    
    let proResult = null;
    if (isPro && illustrationScore !== null) {
      // Pro tier: 5-category verdict (genai + type)
      const proVerdict = getProTierVerdict(aiProbability, illustrationScore);
      proResult = {
        success: true,
        isAI: proVerdict.tier === 'likely_ai' || proVerdict.tier === 'definitely_ai' || proVerdict.tier === 'likely_ai_art',
        aiProbability,
        illustrationScore,
        photoScore,
        confidence: aiProbability,
        verdict: proVerdict.tier,
        verdictLabel: proVerdict.label,
        category: proVerdict.category,
        method: 'sightengine_api_pro',
        indicators: proVerdict.indicators,
        timestamp: Date.now()
      };
    }
    
    // ========================================================================
    // STEP 6: Cache BOTH versions
    // ========================================================================
    // We may not have a Pro response if user was free
    // In that case, when a Pro user later scans the same image, we'd have to re-call
    // To save cost, only cache pro version once we've actually computed it
    if (proResult) {
      await cacheResult(cacheKey, { free: freeResult, pro: proResult });
    } else {
      // Free response only - Pro user later will trigger another call
      await cacheResult(cacheKey, { free: freeResult, pro: null });
    }
    
    if (!isPro) {
      await incrementUserUsage(userId);
    }
    
    const returnedResult = isPro ? proResult : freeResult;
    console.log(`✅ [RESULT] ${returnedResult.verdictLabel} (AI: ${(aiProbability * 100).toFixed(1)}%${illustrationScore !== null ? `, Illust: ${(illustrationScore * 100).toFixed(1)}%` : ''})`);
    
    return res.status(200).json(returnedResult);
    
  } catch (error) {
    console.error('❌ [DETECT ERROR]', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.'
    });
  }
};

// ============================================================================
// FREE TIER VERDICT SYSTEM (3 categories)
// Just AI score → Real / Inconclusive / AI
// ============================================================================

function getFreeTierVerdict(score) {
  const aiPercent = (score * 100).toFixed(1);
  const realPercent = (100 - score * 100).toFixed(1);
  
  // Definitely AI (85%+)
  if (score >= 0.85) {
    return {
      tier: 'definitely_ai',
      label: 'Definitely Faux',
      category: 'ai',
      indicators: [
        `AI confidence: ${aiPercent}%`,
        'Strong AI generation signals detected'
      ],
      proHint: null
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
  
  // Inconclusive (40-65%)
  if (score >= 0.40) {
    return {
      tier: 'inconclusive',
      label: 'Inconclusive',
      category: 'inconclusive',
      indicators: [
        `Score: ${aiPercent}% AI / ${realPercent}% real`,
        '⚠️ Image is in the uncertain detection zone',
        'Could be: heavily filtered photo, digital art, or low-confidence AI'
      ],
      proHint: 'Pro can identify if this is digital art (paintings, game art, 3D)'
    };
  }
  
  // Likely Real (20-40%)
  if (score >= 0.20) {
    return {
      tier: 'likely_real',
      label: 'Likely Real',
      category: 'real',
      indicators: [
        `Real confidence: ${realPercent}%`,
        'Image appears to be human-made'
      ],
      proHint: 'Pro distinguishes real photos from digital art/illustrations'
    };
  }
  
  // Verified Real (0-20%)
  return {
    tier: 'verified_real',
    label: 'Verified Real',
    category: 'real',
    indicators: [
      `Real confidence: ${realPercent}%`,
      'Strong indicators this is genuinely human-made'
    ],
    proHint: 'Pro confirms whether this is photo or illustration'
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

function getProTierVerdict(aiScore, illustrationScore) {
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
      return {
        tier: 'likely_real',
        label: 'Likely Real Photo',
        category: 'real',
        indicators: [
          `Real confidence: ${realPercent}%`,
          'Appears to be a genuine photograph'
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
    return {
      tier: 'verified_real',
      label: 'Verified Real Photo',
      category: 'real',
      indicators: [
        `Real confidence: ${realPercent}%`,
        'Confirmed: genuine photograph'
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
    await kv.incr(key);
    await kv.expire(key, USAGE_TTL_SECONDS);
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
