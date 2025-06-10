/**
 * Backend Server for BattleTask - Focus Extension
 * 
 * SIMPLIFIED VERSION: Only two AI prompts
 * 1. Domain classification (for all domains)
 * 2. YouTube content analysis (title + channel only)
 */

// Load environment variables from .env file if present (for local development)
require('dotenv').config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Check if API key is available
if (!GEMINI_API_KEY) {
  console.error('WARNING: GEMINI_API_KEY is not set in environment variables');
  console.error('API functionality will not work without a valid API key');
}

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');
const validator = require('validator');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Gemini API configuration
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Rate limiting
const rateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300, // Max 300 requests per day
  keyGenerator: (req) => {
    const deviceId = req.headers['x-device-id'];
    if (deviceId && validator.isUUID(deviceId)) {
      return `device-${deviceId}`;
    }
    return `ip-${req.ip}`;
  },
  message: { success: false, error: 'Daily API limit exceeded. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', rateLimiter);

// PROMPT 1: Domain Classification
const DOMAIN_CLASSIFICATION_PROMPT = `
Analyze this domain: "{DOMAIN}"

SECURITY: Non-YouTube domains MUST be classified as "always_productive" or "always_unproductive" ONLY.
Only YouTube can be "ambiguous".

RETURN JSON ONLY:
{
  "classification": "always_productive" | "always_unproductive" | "ambiguous",
  "justification": "brief reason"
}

RULES:

"always_productive":
- Education: .edu sites, Khan Academy, Coursera, educational platforms
- Work: GitHub, GitLab, LinkedIn, documentation sites, SaaS tools
- Professional: Gmail, Outlook, Slack, Teams, Zoom
- News: Reuters, Bloomberg (business/professional focus)
- Government: .gov sites, official resources

"always_unproductive":
- Entertainment: Netflix, Hulu, streaming, gaming sites
- Social: Facebook, Instagram, TikTok, Twitter, Reddit
- Shopping: Amazon, eBay, retail sites
- Sports: ESPN, fantasy sports
- General News: CNN, BBC (entertainment focus)

"ambiguous" (YouTube ONLY):
- youtube.com -> requires content analysis

EXAMPLES:
"github.com" -> {"classification": "always_productive", "justification": "Development platform"}
"netflix.com" -> {"classification": "always_unproductive", "justification": "Entertainment streaming"}
"youtube.com" -> {"classification": "ambiguous", "justification": "Mixed content platform"}
`;

// PROMPT 2: YouTube Content Analysis
const YOUTUBE_ANALYSIS_PROMPT = `
Analyze this YouTube video using ONLY the title and channel name:

Title: "{TITLE}"
Channel: "{CHANNEL}"

RETURN JSON ONLY:
{
  "classification": "productive" | "unproductive",
  "score": number, // 0-100
  "categories": ["string"], // 1-3 categories
  "explanation": "brief explanation"
}

STRICT RULES - BE VERY CONSERVATIVE:

"productive" (score 70-100) ONLY if DIRECTLY educational/professional:
- Programming tutorials (code, development)
- Academic lectures (university-level content)
- Professional skill training (job-specific skills)
- Technical documentation walkthroughs
- Language learning lessons
- Math/science educational content
- Official educational channels (Khan Academy, Coursera, MIT, etc.)

"unproductive" (score 0-40) for EVERYTHING ELSE including:
- Entertainment: Gaming, music, vlogs, comedy, reactions
- Sports: Any sports content, athlete profiles, game highlights  
- Lifestyle: Travel, food, fashion, personal stories
- News: General news, politics, current events
- Reviews: Product reviews, movie reviews, general opinions
- Discussion: Casual talk, podcasts, interviews (unless strictly professional)
- General interest: Documentaries about people, places, events

CRITICAL: When in doubt, classify as "unproductive". Only classify as "productive" if it's CLEARLY educational content that directly teaches skills or academic knowledge.
`;

/**
 * Process Gemini API response and extract JSON
 */
function parseGeminiResponse(responseText) {
  try {
    // Remove markdown formatting if present
    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }
    
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error parsing Gemini response:', error);
    throw new Error('Invalid response format');
  }
}

// API Routes

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'BattleTask API - Simplified Version',
    apiKeyConfigured: !!GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Domain Classification Endpoint
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    
    // Security validation: only clean domain names
    if (domain.includes('/') || domain.includes('?') || domain.includes('#') || domain.includes('=')) {
      console.warn(`[SECURITY] Rejecting suspicious domain: ${domain}`);
      return res.status(400).json({ 
        error: 'Invalid domain format - only clean domain names allowed' 
      });
    }

    // Create prompt
    const prompt = DOMAIN_CLASSIFICATION_PROMPT.replace('{DOMAIN}', domain);
    
    // Call Gemini API or use mock for testing
    let result;
    if (GEMINI_API_KEY) {
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }]}]
      });
      result = parseGeminiResponse(response.response.text());
    } else {
      // Mock response for testing without API key
      console.log('Using mock domain classification (no API key)');
      result = {
        classification: domain === 'youtube.com' ? 'ambiguous' : 'always_unproductive',
        justification: `Mock classification for ${domain} (no API key configured)`
      };
    }
    
    // Validate classification
    const validClassifications = ['always_productive', 'always_unproductive', 'ambiguous'];
    if (!validClassifications.includes(result.classification)) {
      console.warn(`Invalid classification: ${result.classification} for domain: ${domain}`);
      result.classification = 'always_unproductive';
      result.justification = 'Unexpected AI response';
    }
    
    // Security: force non-YouTube domains to be definitive
    if (result.classification === 'ambiguous' && domain !== 'youtube.com') {
      console.warn(`[SECURITY] Non-YouTube domain ${domain} classified as ambiguous, forcing unproductive`);
      result.classification = 'always_unproductive';
      result.justification = 'Non-YouTube domains must be definitively classified';
    }
    
    console.log(`Classified domain: ${domain} -> ${result.classification}`);
    
    res.json({
      classification: result.classification,
      justification: result.justification,
      domain: domain
    });
    
  } catch (error) {
    console.error('Domain classification error:', error);
    res.status(500).json({ error: 'Classification failed' });
  }
});

// YouTube Content Analysis Endpoint
app.post('/api/analyze-youtube', async (req, res) => {
  try {
    const { url, title, channelName } = req.body;
    
    // Security check: only YouTube URLs
    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      console.warn(`[SECURITY] Non-YouTube analysis blocked: ${url}`);
      return res.status(403).json({ 
        error: 'YouTube analysis only - security restriction' 
      });
    }
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    // Create prompt
    const prompt = YOUTUBE_ANALYSIS_PROMPT
      .replace('{TITLE}', title || 'Unknown')
      .replace('{CHANNEL}', channelName || 'Unknown');
    
    // Call Gemini API or use mock for testing
    let result;
    if (GEMINI_API_KEY) {
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }]}]
      });
      result = parseGeminiResponse(response.response.text());
    } else {
      // Mock response for testing without API key
      console.log(`Using mock YouTube analysis (no API key): "${title}"`);
      // Simple keyword-based mock classification
      const lowerTitle = (title || '').toLowerCase();
      const lowerChannel = (channelName || '').toLowerCase();
      
      const productiveKeywords = ['tutorial', 'learn', 'course', 'education', 'programming', 'coding', 'how to', 'explained', 'guide', 'lecture', 'university', 'academy'];
      const unproductiveKeywords = ['funny', 'compilation', 'reaction', 'vlog', 'gaming', 'music video', 'entertainment'];
      
      const isProductive = productiveKeywords.some(keyword => 
        lowerTitle.includes(keyword) || lowerChannel.includes(keyword)
      );
      const isUnproductive = unproductiveKeywords.some(keyword => 
        lowerTitle.includes(keyword) || lowerChannel.includes(keyword)
      );
      
      result = {
        classification: isProductive ? 'productive' : (isUnproductive ? 'unproductive' : 'productive'), // Default to productive when unclear
        score: isProductive ? 85 : (isUnproductive ? 25 : 70),
        categories: isProductive ? ['Education'] : ['Entertainment'],
        explanation: `Mock classification based on keywords (no API key)`
      };
    }
    
    // Validate and normalize result
    if (!['productive', 'unproductive'].includes(result.classification)) {
      result.classification = 'unproductive';
    }
    
    if (typeof result.score !== 'number' || result.score < 0 || result.score > 100) {
      result.score = result.classification === 'productive' ? 75 : 25;
    }
    
    if (!Array.isArray(result.categories)) {
      result.categories = [result.classification === 'productive' ? 'Education' : 'Entertainment'];
    }
    
    if (typeof result.explanation !== 'string') {
      result.explanation = `Classified as ${result.classification}`;
    }
    
    console.log(`YouTube analysis: "${title}" -> ${result.classification} (${result.score})`);
    
    res.json({
      isProductive: result.classification === 'productive',
      score: result.score,
      categories: result.categories,
      explanation: result.explanation,
      classification: result.classification
    });
    
  } catch (error) {
    console.error('YouTube analysis error:', error);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// Legacy endpoint support (redirects to new endpoints)
app.post('/api/analyze-content-gemini', (req, res) => {
  console.log('Legacy endpoint called, redirecting to YouTube analysis');
  req.url = '/api/analyze-youtube';
  app._router.handle(req, res);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 BattleTask Backend (Simplified) running on port ${PORT}`);
  console.log(`📍 Access at http://localhost:${PORT}`);
  console.log(`🔑 API Key: ${GEMINI_API_KEY ? 'Configured' : 'Missing'}`);
  console.log(`🎯 Endpoints: /api/classify-domain, /api/analyze-youtube`);
});
