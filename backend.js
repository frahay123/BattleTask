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

// Per-user/device rate limiting is the primary limiter.
// It uses a device ID if available, otherwise falls back to the client's IP address.
// The general IP-based limiter has been removed as this one already provides an IP fallback.
const userDeviceLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300, // Hard limit of 300 requests per day per identified key
  keyGenerator: (req) => {
    // 1. Prioritize Authenticated User ID (if you implement sending it in the future)
    //    Example: if (req.body && req.body.userId) return `user-${req.body.userId}`;
    //    Example: if (req.headers['x-user-id']) return `user-${req.headers['x-user-id']}`;

    // 2. Use Client-Generated Device ID from header
    const deviceId = req.headers['x-device-id'];
    if (deviceId && validator.isUUID(deviceId)) {
      // Ensure it's a valid UUID to prevent misuse of this header
      return `device-${deviceId}`;
    }

    // 3. Fallback to IP address if no valid User ID or Device ID is found
    // The ipLimiter above already provides general IP protection.
    // This keyGenerator ensures that if a device ID IS present, it's preferred over just IP for THIS limiter.
    // If deviceId is missing/invalid, this limiter will also use IP, effectively layering with ipLimiter for those cases.
    return `ip-${req.ip}`; 
  },
  message: { success: false, error: 'API rate limit exceeded for this user/device. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', userDeviceLimiter); // Apply this limiter to all /api/ routes

/**
 * Extracts a JSON object from a string, handling markdown code blocks.
 * @param {string} text The text response from the AI.
 * @returns {object|null} The parsed JSON object or null if parsing fails.
 */
function extractJsonFromResponse(text) {
  if (!text) return null;
  
  let jsonString = text;
  
  // Handle cases where the JSON is wrapped in ```json ... ``` or ``` ... ```
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
 * Analyze a YouTube video title to determine if it's productive content
 */
async function analyzeYouTubeTitle(title) {
  if (!title || title.trim() === '' || title === 'New Tab') {
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Empty or invalid title provided.'
    };
  }

  try {
    const prompt = `
        Analyze this YouTube video title: "${title} and channel name: ${channelName} and channel description: ${channelDescription}"

        Classify strictly as "productive" or "unproductive".
        Provide a concise explanation.
        Assign a score (0-100).
        List relevant categories (1-3 words each).

        RETURN JSON ONLY:
        {
          "isProductive": boolean, // true if productive
          "score": number, // 0-100
          "categories": ["string"],
          "explanation": "string"
        }

        CRITICAL RULES FOR "productive" (score 75-100):
        1. Title indicates: Lectures, tutorials, documentaries, academic lessons (math, science, history, programming, languages, etc.), how-to guides.
        
        If title matches CRITICAL RULES, it IS "productive".
        Titles suggesting primarily entertainment are "unproductive".
      `;
      
      // Make request to Gemini API
      const result = await model.generateContent(prompt);
      const response = result.response;
      return processGeminiTitleResponse(response);
  } catch (error) {
    console.error('Error analyzing YouTube title:', error);
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error during analysis'
    };
  }
}

/**
 * Process Gemini response for title analysis
 * @param {Object} response - Gemini API response
 * @returns {Object} - Processed response
 */
function processGeminiTitleResponse(response) {
  try {
    const responseText = response.text();
    const analysis = extractJsonFromResponse(responseText);

    if (!analysis) {
      // If JSON parsing fails, fall back to simple text analysis.
      const text = responseText.toLowerCase();
      let isProductive = false;
      let score = 30;
      if (text.includes('productive') || text.includes('education') || text.includes('academic') || text.includes('learning')) {
        isProductive = true;
        score = 75;
      }
      return {
        isProductive,
        score,
        categories: ['Unknown'],
        explanation: 'Could not parse structured response from AI.'
      };
    }

    // Ensure required fields exist and have correct types
    if (typeof analysis.isProductive !== 'boolean') {
      analysis.isProductive = false;
    }
    
    if (typeof analysis.score !== 'number') {
      const parsedScore = parseFloat(analysis.score);
      analysis.score = !isNaN(parsedScore) ? parsedScore : 0;
    }
    
    // Normalize score to 0-100 range (prompt requests 0-100, this is a safeguard)
    if (analysis.score <= 1 && analysis.score >= 0 && analysis.score !== 0 && analysis.score !== 1) {
      analysis.score = Math.round(analysis.score * 100);
    } else {
      analysis.score = Math.min(100, Math.max(0, analysis.score));
    }
    
    if (!Array.isArray(analysis.categories)) {
      analysis.categories = [];
    }
    if (typeof analysis.explanation !== 'string') {
      analysis.explanation = '';
    }

    return analysis;
  } catch (jsonError) {
    console.error('Error parsing JSON from title analysis:', jsonError);
    
    // If can't parse JSON, fallback to text analysis
    const responseText = response.text() || '';
    const text = responseText.toLowerCase();
    
    // Default classification
    let isProductive = false;
    let score = 30;
    let categories = ['Unknown'];
    let explanation = 'Could not parse response';
    
    // Check for educational indicators in the text
    if (text.includes('productive') || 
        text.includes('education') || 
        text.includes('academic') || 
        text.includes('learning')) {
      isProductive = true;
      score = 75;
      categories = ['Education'];
      explanation = 'Educational content detected';
    }
    
    return {
      isProductive,
      score,
      categories,
      explanation
    };
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

// Analyze a title directly from the frontend
app.post('/api/analyze-youtube-title', async (req, res) => {
  try {
    const { title, url } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    if (!url || !url.includes('youtube.com')) {
        return res.status(400).json({ success: false, error: 'A YouTube URL is required for this endpoint.' });
    }
    
    // Sanitize title
    const cleanTitle = validator.escape(title);
    
    const analysis = await analyzeYouTubeTitle(cleanTitle);
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing YouTube title:', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Add new API endpoints for Gemini integration for domain and content classification

// Endpoint for classifying domains with Gemini
app.post('/api/analyze-domain', async (req, res) => {
  try {
    const { domain } = req.body; // Expect only domain from client
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    const prompt = `
      Analyze domain: "${domain}"
      Classify STRICTLY as "productive" or "unproductive".
      Prioritize DOMINANT purpose. Justify briefly.

      RETURN JSON ONLY:
      {
        "classification": "chosen_classification_value",
        "justification": "brief_justification"
      }

      RULES:

      "productive":
      - Education: university, online courses, research, Wikipedia, Khan Academy.
      - Work/Career/Business: SaaS tools, GitHub, LinkedIn, finance tools, B2B, money-making ventures, professional news.
      - Essential Info: government sites, technical documentation.
      - Factual News (source focus): Reuters, Associated Press.

      "unproductive":
      - Entertainment: streaming (Netflix, not pure ed-platforms), games, celebrity gossip, comics.
      - Sports: ESPN, talksport.com.
      - Social Media (leisure focus): Facebook, Instagram, TikTok, Pinterest.
      - Shopping (personal consumer goods): Amazon, eBay, fashion retail.
      - Hobby Forums (non-work/education).
      - Gambling/Betting.
      - Broad news with opinion/lifestyle: CNN, Buzzfeed.


      EXAMPLES:
      Domain: "github.com" -> {"classification": "productive", "justification": "Software dev & collab."}
      Domain: "coursera.org" -> {"classification": "productive", "justification": "Online courses."}
      Domain: "forbes.com" -> {"classification": "productive", "justification": "Business & finance news."}
      
      Domain: "talksport.com" -> {"classification": "unproductive", "justification": "Sports news/entertainment."}
      Domain: "tiktok.com" -> {"classification": "unproductive", "justification": "Short video entertainment."}
      Domain: "amazon.com" -> {"classification": "unproductive", "justification": "E-commerce shopping."}
      Domain: "cnn.com" -> {"classification": "unproductive", "justification": "Broad news, opinion, lifestyle."}

      Analyze: "${domain}"
    `;
    
    // Use the same gemini model for classification. 
    // Simplified the API call to match the working implementation in analyzeYouTubeTitle.
    const result = await model.generateContent(prompt);
    const response = result.response;
    const responseText = response?.text()?.trim() || '';
    let classificationResult = extractJsonFromResponse(responseText);

    if (classificationResult) {
      // Ensure classification is one of our expected values
      if (!['productive', 'unproductive'].includes(classificationResult.classification)) {
        console.warn(`Unexpected Gemini response for domain classification: "${classificationResult.classification}". Defaulting to unproductive for domain: ${domain}`);
        classificationResult.classification = 'unproductive';
        classificationResult.justification = classificationResult.justification || 'Unexpected response from AI.';
      }
    } else {
      // This block runs if extractJsonFromResponse returns null (i.e., parsing failed)
      console.error(`Could not parse JSON for domain classification (${domain}). Response text:`, responseText);
      classificationResult = {
        classification: 'unproductive', // Default on error
        justification: 'Error parsing AI response.'
      };
    }
    
    // Log the classification for analytics
    console.log(`Gemini classified domain: ${domain} as ${classificationResult.classification}`);
    
    return res.status(200).json({ 
      classification: classificationResult.classification,
      justification: classificationResult.justification,
      domain: domain
    });
  } catch (error) {
    console.error('Error classifying domain with Gemini:', error);
    return res.status(500).json({ error: 'Error processing domain classification request' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
