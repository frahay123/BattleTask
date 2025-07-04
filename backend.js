/**
 * Backend Server for BattleTask - Focus Extension
 * 
 * This server provides:
 * 1. Educational content analysis using Google's Gemini API
 * 2. REST API for Chrome extension
 */

// Load environment variables from .env file if present (for local development)
require('dotenv').config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Check if API key is available
if (!GEMINI_API_KEY) {
  console.error('WARNING: GEMINI_API_KEY is not set in environment variables');
  console.error('API functionality will not work without a valid API key');
  // Not exiting process - allows server to start for health checks
  // process.exit(1); 
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

// For environments like Cloud Run that use a proxy, this setting is required
// for express-rate-limit to correctly identify the client IP address.
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(bodyParser.json());

// -------- Rate Limiting --------
// 1. Device-ID based limiter (stricter – 300 req / day)
const deviceLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 h
  max: 300,
  skip: (req) => {
    const deviceId = req.headers['x-device-id'];
    // Skip if no valid UUID – let the IP limiter handle it instead
    return !(deviceId && validator.isUUID(deviceId));
  },
  keyGenerator: (req) => `device-${req.headers['x-device-id']}`,
  message: { success: false, error: 'Daily device limit reached. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 2. IP based fallback limiter (broader – 1000 req / day)
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => `ip-${req.ip}`,
  message: { success: false, error: 'Daily IP limit reached. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply both limiters to all API routes (device first, then IP)
app.use('/api/', deviceLimiter, ipLimiter);

/**
 * Extracts a JSON object from a string, handling markdown code blocks.
 * @param {string} text The text response from the AI.
 * @returns {object|null} The parsed JSON object or null if parsing fails.
 */
function extractJsonFromResponse(text) {
  if (!text) return null;

  let jsonString = text;
  if (jsonString.startsWith('```json')) {
    jsonString = jsonString.substring(7, jsonString.length - 3).trim();
  } else if (jsonString.startsWith('```')) {
    jsonString = jsonString.substring(3, jsonString.length - 3).trim();
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Failed to parse JSON from AI response. Text:', text, 'Error:', error);
    return null;
  }
}

/**
 * Analyze a YouTube video to determine if it's productive content.
 * @param {string} title The title of the YouTube video.
 * @param {string} channelName The name of the YouTube channel.
 * @param {string} description The description of the YouTube video.
 * @returns {Promise<Object>} A promise that resolves to the analysis object.
 */
async function analyzeYouTubeContent(title, channelName, description) {
  if (!title) {
    return { isProductive: false, score: 0, categories: [], explanation: 'Empty or invalid title provided.' };
  }

  try {
    const prompt = `
        Analyze this YouTube video based on its title, channel, and description.

        Title: "${title}"
        Channel: "${channelName || 'N/A'}"
        Description (first 200 chars): "${(description || 'N/A').substring(0, 200)}"

        Classify strictly as "productive" or "unproductive".
        Provide a concise explanation.
        Assign a score (0-100).
        List relevant categories (1-3 words each).

        RETURN JSON ONLY:
        {
          "isProductive": boolean,
          "score": number,
          "categories": ["string"],
          "explanation": "string"
        }
       

        CRITICAL RULES FOR "productive" (score 75-100):
        1. Title, channel, or description indicate: Lectures, tutorials, documentaries, academic lessons (math, science, history, programming, languages, etc.), how-to guides.

        If content matches CRITICAL RULES, it IS "non-productive".
        Cricital Rules: Content focused on entertainment (gaming, vlogs, comedy, sports, songs, anything entertainment, shopping,SNL,mrbeast,kai cenant) is "unproductive".
        BE EXTREMELY STRICT. ONLY CLEARLY PRODUCTIVE VIDEOS SHOULD BE GREEN
      `;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const responseText = response.text();
    const analysis = extractJsonFromResponse(responseText);

    if (!analysis) {
        return { isProductive: false, score: 0, categories: [], explanation: 'Could not parse AI response.' };
    }
    
    // Sanitize and normalize response
    analysis.isProductive = typeof analysis.isProductive === 'boolean' ? analysis.isProductive : false;
    analysis.score = typeof analysis.score === 'number' ? Math.min(100, Math.max(0, analysis.score)) : 0;
    analysis.categories = Array.isArray(analysis.categories) ? analysis.categories : [];
    analysis.explanation = typeof analysis.explanation === 'string' ? analysis.explanation : '';
    
    return analysis;

  } catch (error) {
    console.error('Error analyzing YouTube content:', error);
    return { isProductive: false, score: 0, categories: [], explanation: 'Error during analysis.' };
  }
}

// API Routes

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'BattleTask API is running',
    apiKeyConfigured: !!GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Endpoint for analyzing YouTube content
app.post('/api/analyze-youtube-content', async (req, res) => {
  try {
    const { title, url, channelName, description } = req.body;

    if (!title || !url || !url.includes('youtube.com')) {
      return res.status(400).json({ success: false, error: 'Valid YouTube title and URL are required.' });
    }

    const cleanTitle = validator.escape(title);
    const cleanChannelName = channelName ? validator.escape(channelName) : '';
    const cleanDescription = description ? validator.escape(description) : '';

    const analysis = await analyzeYouTubeContent(cleanTitle, cleanChannelName, cleanDescription);

    res.json({ success: true, ...analysis });
  } catch (error) {
    console.error('Error in /api/analyze-youtube-content:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// Endpoint for classifying domains
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    const prompt = `
      Analyze domain: "${domain}"
      Classify STRICTLY as "always_productive" or "always_unproductive".
      Prioritize DOMINANT purpose.

      RETURN JSON ONLY:
      {
        "classification": "chosen_classification_value"
      }

      RULES:
      "always_productive": Education (e.g., coursera.org), Work/Business (e.g., github.com), Essential Info (e.g., gov sites).
      "always_unproductive": Entertainment (e.g., netflix.com), Social Media (e.g., tiktok.com), Shopping (e.g., amazon.com).

      EXAMPLES:
      Domain: "github.com" -> {"classification": "always_productive"}
      Domain: "tiktok.com" -> {"classification": "always_unproductive"}

      Analyze: "${domain}"
    `;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const classificationResult = extractJsonFromResponse(response.text());

    if (!classificationResult || !['always_productive', 'always_unproductive'].includes(classificationResult.classification)) {
        console.warn(`Unexpected Gemini response for domain classification. Defaulting for domain: ${domain}`);
        return res.status(200).json({ classification: 'always_unproductive', domain: domain });
    }

    console.log(`Gemini classified domain: ${domain} as ${classificationResult.classification}`);
    // backend.js – inside your Express handler
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

    // ipinfo.io returns { city, region, country, … }
    const { city, region, country } = await fetch(`https://ipinfo.io/${ip}/json`)
                                            .then(r => r.json())
                                            .catch(() => ({}));   // fail-safe

    console.log(
      `Classify-domain call from: ${city || 'unknown city'}, ` +
      `${region || 'unknown region'}, ${country || 'unknown country'}`
    );

    // …rest of your code…
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
    return res.status(200).json({ ...classificationResult, domain: domain });

  } catch (error) {
    console.error('Error classifying domain with Gemini:', error);
    return res.status(500).json({ error: 'Error processing domain classification request' });
  }
});

// Endpoint kept for backward-compatibility: analyze a title (YouTube only)
app.post('/api/analyze-title', async (req, res) => {
  try {
    const { title, url, channelName, description } = req.body;

    if (!title || !url) {
      return res.status(400).json({ success: false, error: 'Title and URL are required.' });
    }

    if (!url.includes('youtube.com')) {
      return res.status(400).json({ success: false, error: 'This endpoint now only supports YouTube URLs.' });
    }

    const cleanTitle = validator.escape(title);
    const cleanChannelName = channelName ? validator.escape(channelName) : '';
    const cleanDescription = description ? validator.escape(description) : '';

    const analysis = await analyzeYouTubeContent(cleanTitle, cleanChannelName, cleanDescription);
    try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

    // ipinfo.io returns { city, region, country, … }
    const { city, region, country } = await fetch(`https://ipinfo.io/${ip}/json`)
                                            .then(r => r.json())
                                            .catch(() => ({}));   // fail-safe

    console.log(
      `Classify-title call from: ${city || 'unknown city'}, ` +
      `${region || 'unknown region'}, ${country || 'unknown country'}`
    );

    // …rest of your code…
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
    res.json({ success: true, ...analysis });
  } catch (error) {
    console.error('Error in /api/analyze-title:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
