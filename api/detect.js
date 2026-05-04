// /api/detect.js
// Faux Spy Detection Proxy with persistent storage
// Uses Vercel KV for caching and rate limiting

const { kv } = require('@vercel/kv');

const FREE_TIER_DAILY_LIMIT = 20;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const USAGE_TTL_SECONDS = 25 * 60 * 60; // 25 hours (one full day + buffer)

// In-memory fallbacks if KV is not configured
const inMemoryUsage = new Map();
const inMemoryCache = new Map();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { imageUrl, userId, isPro } = req.body || {};
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl required' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    
    try {
      new URL(imageUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid imageUrl' });
    }
    
    if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
      return res.status(400).json({ error: 'Cannot analyze data: or blob: URLs' });
    }
    
    // v3.1: Reject obviously low-quality images
    // Detection on tiny images is unreliable — better to refuse than mislead
    const imgWidth = req.body.width || 0;
    const imgHeight = req.body.height || 0;
    
    if (imgWidth > 0 && imgHeight > 0) {
      // Reject anything under 100x100 (likely icons, avatars, thumbnails)
      if (imgWidth < 100 || imgHeight < 100) {
        return res.status(200).json({
          success: true,
          isAI: false,
          aiProbability: 0,
          verdict: 'insufficient_data',
          verdictLabel: 'Image Too Small',
          indicators: [
            `Image is ${imgWidth}×${imgHeight} pixels`,
            'Detection requires images at least 100×100 pixels',
            'Try a larger version of this image'
          ],
          method: 'pre_check_failed',
          reason: 'image_too_small'
        });
      }
    }
    
    // ========================================================================
    // STEP 1: Check cache (massive cost savings)
    // ========================================================================
    const cacheKey = `detect:${await hashUrl(imageUrl)}`;
    const cached = await getCached(cacheKey);
    
    if (cached) {
      console.log('💾 [CACHE HIT]', imageUrl.substring(0, 60));
      
      // Cached results don't count toward daily limit (already paid for)
      return res.status(200).json({
        ...cached,
        cached: true
      });
    }
    
    // ========================================================================
    // STEP 2: Check daily limit (persistent across deploys now)
    // ========================================================================
    if (!isPro) {
      const usage = await getUserUsage(userId);
      
      if (usage >= FREE_TIER_DAILY_LIMIT) {
        return res.status(429).json({
          error: 'DAILY_LIMIT_REACHED',
          message: `Free tier limit reached (${FREE_TIER_DAILY_LIMIT}/day). Upgrade to Pro for unlimited.`,
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
    // ========================================================================
    console.log('🔍 [DETECT]', imageUrl.substring(0, 80));
    
    const params = new URLSearchParams({
      url: imageUrl,
      models: 'genai',
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
    
    const aiProbability = data.type?.ai_generated;
    
    if (typeof aiProbability !== 'number') {
      console.error('❌ Unexpected response:', data);
      return res.status(500).json({
        error: 'INVALID_RESPONSE',
        message: 'Detection returned unexpected format'
      });
    }
    
    // ========================================================================
    // STEP 5: Build result with conservative tier system
    // ========================================================================
    
    // v3.1: Conservative thresholds to minimize false positives
    // Real photos with filters often score 0.40-0.60 — those should be "Inconclusive"
    // Only commit to "AI" verdict at 65%+ confidence
    const verdict = getVerdictFromScore(aiProbability, imageUrl);
    
    const result = {
      success: true,
      // isAI is now only true if we're confidently calling it AI
      // "Inconclusive" returns isAI: false (don't accuse without evidence)
      isAI: verdict.tier === 'likely_ai' || verdict.tier === 'definitely_ai',
      aiProbability,
      confidence: aiProbability,
      verdict: verdict.tier,
      verdictLabel: verdict.label,
      method: 'sightengine_api',
      indicators: verdict.indicators,
      timestamp: Date.now()
    };
    
    // ========================================================================
    // STEP 6: Cache + increment usage (persistent now)
    // ========================================================================
    await cacheResult(cacheKey, result);
    
    if (!isPro) {
      await incrementUserUsage(userId);
    }
    
    console.log(`✅ [RESULT] ${(aiProbability * 100).toFixed(1)}% AI`);
    
    return res.status(200).json(result);
    
  } catch (error) {
    console.error('❌ [DETECT ERROR]', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.'
    });
  }
};

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
// CONSERVATIVE VERDICT SYSTEM (v3.1)
// ============================================================================
// 
// Threshold strategy designed to minimize false positives:
// - 0.00-0.20: Verified Real (very confident)
// - 0.20-0.40: Likely Real
// - 0.40-0.65: Inconclusive (HONEST UNCERTAINTY ZONE)
// - 0.65-0.85: Likely AI
// - 0.85-1.00: Definitely AI (very confident)
//
// Why 65% threshold for AI claim?
// - Real photos with heavy filters score 0.45-0.60 on Sightengine
// - Genuine AI images typically score 0.85+ 
// - 65% gives buffer to catch edited photos before calling them AI
// - Small accuracy cost (some genuine AI scoring 0.55-0.65 → "Inconclusive")
// - But: never falsely accuse a real photo
//
// ============================================================================

function getVerdictFromScore(score, imageUrl = '') {
  const percent = (score * 100).toFixed(1);
  const realPercent = (100 - score * 100).toFixed(1);
  
  // Domain-aware context (light hints, not overrides)
  const context = analyzeUrlContext(imageUrl);
  
  // Tier 1: Definitely AI (85%+)
  if (score >= 0.85) {
    return {
      tier: 'definitely_ai',
      label: 'Definitely Faux',
      indicators: [
        `Sightengine AI confidence: ${percent}%`,
        'Strong AI generation signals detected',
        ...(context.suggestsAI ? ['Source context supports AI verdict'] : [])
      ]
    };
  }
  
  // Tier 2: Likely AI (65-85%)
  if (score >= 0.65) {
    return {
      tier: 'likely_ai',
      label: 'Likely Faux',
      indicators: [
        `Sightengine AI confidence: ${percent}%`,
        'AI generation patterns detected',
        ...(context.suggestsAI ? ['Source context supports AI verdict'] : [])
      ]
    };
  }
  
  // Tier 3: Inconclusive (40-65%) — THE KEY CHANGE
  // This zone is wider than typical to catch filter-heavy photos
  if (score >= 0.40) {
    const indicators = [
      `Sightengine score: ${percent}% AI / ${realPercent}% real`,
      '⚠️ Image is in the uncertain detection zone',
      'Could be: heavily filtered photo, AI-edited real image, or low-confidence AI'
    ];
    
    // Helpful context for filtered photos
    if (context.likelyFilter) {
      indicators.push('💡 Filter or heavy editing may be affecting detection');
    }
    
    return {
      tier: 'inconclusive',
      label: 'Inconclusive',
      indicators
    };
  }
  
  // Tier 4: Likely Real (20-40%)
  if (score >= 0.20) {
    return {
      tier: 'likely_real',
      label: 'Likely Real',
      indicators: [
        `Sightengine real confidence: ${realPercent}%`,
        'Image appears to be human-made',
        ...(context.likelyFilter ? ['Some filter/editing detected'] : [])
      ]
    };
  }
  
  // Tier 5: Verified Real (0-20%)
  return {
    tier: 'verified_real',
    label: 'Verified Real',
    indicators: [
      `Sightengine real confidence: ${realPercent}%`,
      'Strong indicators this is a genuine photograph',
      ...(context.suggestsReal ? ['Source context supports real verdict'] : [])
    ]
  };
}

// ============================================================================
// URL CONTEXT ANALYSIS (light hints only)
// ============================================================================

function analyzeUrlContext(imageUrl) {
  const context = {
    likelyFilter: false,
    suggestsAI: false,
    suggestsReal: false
  };
  
  if (!imageUrl) return context;
  
  const url = imageUrl.toLowerCase();
  
  // Sites that primarily host AI-generated content
  const aiSourceDomains = [
    'civitai.com', 'midjourney.com', 'lexica.art', 'leonardo.ai',
    'playgroundai.com', 'dezgo.com', 'mage.space', 'nightcafe.studio',
    'starryai.com', 'wombo.art', 'artbreeder.com'
  ];
  
  if (aiSourceDomains.some(domain => url.includes(domain))) {
    context.suggestsAI = true;
  }
  
  // Sites that primarily host real photography
  const realSourceDomains = [
    'reuters.com', 'apnews.com', 'gettyimages.com', 'shutterstock.com',
    'unsplash.com', 'pexels.com', 'flickr.com', 'pinterest.com/pin'
  ];
  
  if (realSourceDomains.some(domain => url.includes(domain))) {
    context.suggestsReal = true;
  }
  
  // Instagram/Pinterest CDNs — often have filtered content
  const filterHeavyDomains = [
    'cdninstagram.com', 'fbcdn.net', 'pinimg.com',
    'tiktokcdn.com', 'snapchat.com'
  ];
  
  if (filterHeavyDomains.some(domain => url.includes(domain))) {
    context.likelyFilter = true;
  }
  
  return context;
}

// ============================================================================
// STORAGE: User usage tracking (persistent via Vercel KV)
// ============================================================================

async function getUserUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `usage:${userId}:${today}`;
  
  try {
    const usage = await kv.get(key);
    return usage || 0;
  } catch (kvError) {
    // Fallback to in-memory if KV not configured
    console.warn('⚠️ KV unavailable for usage check, using memory');
    const memUsage = inMemoryUsage.get(key);
    return memUsage?.count || 0;
  }
}

async function incrementUserUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `usage:${userId}:${today}`;
  
  try {
    // Atomic increment with TTL
    await kv.incr(key);
    await kv.expire(key, USAGE_TTL_SECONDS);
  } catch (kvError) {
    // Fallback to in-memory
    const current = inMemoryUsage.get(key) || { date: today, count: 0 };
    current.count += 1;
    inMemoryUsage.set(key, current);
  }
}

// ============================================================================
// STORAGE: Result caching (persistent via Vercel KV)
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
    
    return cached.result;
  }
}

async function cacheResult(cacheKey, result) {
  try {
    // Set with TTL (auto-expires after 30 days)
    await kv.set(cacheKey, result, { ex: CACHE_TTL_SECONDS });
  } catch (kvError) {
    // Fallback to in-memory with size limit
    inMemoryCache.set(cacheKey, {
      result,
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
