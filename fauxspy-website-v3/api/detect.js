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
    // STEP 5: Build result
    // ========================================================================
    const result = {
      success: true,
      isAI: aiProbability > 0.5,
      aiProbability,
      confidence: aiProbability,
      method: 'sightengine_api',
      indicators: buildIndicators(aiProbability),
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

function buildIndicators(aiProbability) {
  const indicators = [];
  const percent = (aiProbability * 100).toFixed(1);
  
  if (aiProbability > 0.5) {
    indicators.push(`Sightengine AI confidence: ${percent}%`);
    if (aiProbability > 0.9) indicators.push('Extremely likely AI-generated');
    else if (aiProbability > 0.75) indicators.push('Very likely AI-generated');
    else indicators.push('Likely AI-generated');
  } else {
    indicators.push(`Sightengine real confidence: ${(100 - percent).toFixed(1)}%`);
    if (aiProbability < 0.1) indicators.push('Extremely likely human-made');
    else if (aiProbability < 0.25) indicators.push('Very likely human-made');
    else indicators.push('Likely human-made');
  }
  
  return indicators;
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
