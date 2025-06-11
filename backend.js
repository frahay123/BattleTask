/**
 * Backend Server for BattleTask - Focus Extension
 * 
 * This server provides:
 * 1. Domain classification (productive/non-productive only)
 * 2. YouTube video content analysis
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

// General IP-based rate limiting
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300, // Max 300 requests per IP per day
  message: { success: false, error: 'Too many requests from this IP, try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', ipLimiter);

// Per-user/device rate limiting
const userDeviceLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300, // Hard limit of 300 requests per day per identified key
  keyGenerator: (req) => {
    const deviceId = req.headers['x-device-id'];
    if (deviceId && validator.isUUID(deviceId)) {
      return `device-${deviceId}`;
    }
    return `ip-${req.ip}`; 
  },
  message: { success: false, error: 'API rate limit exceeded for this user/device. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', userDeviceLimiter);

/**
 * Analyze YouTube video content to determine productivity
 */
async function analyzeYouTubeVideo(title, description = '', channelName = '') {
  try {
    const prompt = `
      Analyze this YouTube video:

      Title: "${title}"
      Channel: "${channelName}"
      Description: "${description.substring(0, 500)}"

      Classify strictly as "productive" or "non-productive".
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

      RULES FOR "productive" (score 75-100):
      - Educational content: tutorials, lectures, documentaries, academic lessons
      - Skill development: how-to guides, professional training, coding tutorials
      - Informative: news analysis, research explanations, technical deep-dives
      - Known educational channels or clear learning intent

      RULES FOR "non-productive" (score 0-40):
      - Entertainment: music videos, comedy, vlogs, gaming content
      - Social content: reactions, challenges, lifestyle videos
      - Clickbait or superficial content

      When unclear, lean towards the primary intent based on title and channel context.
    `;
    
    const result = await model.generateContent(prompt);
    const response = result.response;
    let responseText = response.text();

    // Clean markdown formatting
    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }

    const analysis = JSON.parse(responseText);

    // Validate and normalize response
    if (typeof analysis.isProductive !== 'boolean') {
      analysis.isProductive = false;
    }
    if (typeof analysis.score !== 'number') {
      const parsedScore = parseFloat(analysis.score);
      analysis.score = !isNaN(parsedScore) ? parsedScore : 0;
    }
    analysis.score = Math.min(100, Math.max(0, analysis.score));
    
    if (!Array.isArray(analysis.categories)) {
      analysis.categories = [];
    }
    if (typeof analysis.explanation !== 'string') {
      analysis.explanation = '';
    }

    return analysis;
  } catch (error) {
    console.error('Error analyzing YouTube video:', error);
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error during analysis'
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

// Domain classification endpoint
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    // Special case: youtube.com is always ambiguous
    if (domain.toLowerCase() === 'youtube.com') {
      return res.status(200).json({ 
        classification: 'ambiguous',
        justification: 'YouTube contains both educational and entertainment content',
        domain: domain
      });
    }

    const prompt = `
      Analyze domain: "${domain}"
      
      Classify STRICTLY as "productive" or "non-productive".
      Provide brief justification.

      RETURN JSON ONLY:
      {
        "classification": "productive" | "non-productive", 
        "justification": "short_reason"
      }

      RULES:

      "productive":
      - Education: universities, online courses, research, Wikipedia, Khan Academy
      - Work/Business: SaaS tools, GitHub, LinkedIn, professional platforms
      - Essential services: email, banking, government sites, documentation
      - News: reputable news sources focused on information

      "non-productive":
      - Entertainment: streaming, gaming, social media, celebrity content
      - Shopping: e-commerce, retail sites
      - Sports/leisure: sports news, hobby forums, lifestyle content
      - Time-wasting: clickbait, gossip, casual browsing sites

      Examples:
      "github.com" -> {"classification": "productive", "justification": "Software development platform"}
      "netflix.com" -> {"classification": "non-productive", "justification": "Entertainment streaming"}
      "gmail.com" -> {"classification": "productive", "justification": "Email service"}
      "facebook.com" -> {"classification": "non-productive", "justification": "Social media platform"}

      Analyze: "${domain}"
    `;
    
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    
    const result = response.response;
    let responseText = result?.text()?.trim() || '';
    let classificationResult;

    try {
      if (responseText.includes('```json')) {
        responseText = responseText.split('```json')[1].split('```')[0].trim();
      } else if (responseText.includes('```')) {
        responseText = responseText.split('```')[1].split('```')[0].trim();
      }
      classificationResult = JSON.parse(responseText);

      // Ensure classification is valid
      if (!['productive', 'non-productive'].includes(classificationResult.classification)) {
        console.warn(`Unexpected classification: "${classificationResult.classification}". Defaulting to non-productive for domain: ${domain}`);
        classificationResult.classification = 'non-productive';
        classificationResult.justification = classificationResult.justification || 'Unexpected response from AI.';
      }
    } catch (e) {
      console.error(`Error parsing JSON for domain classification (${domain}):`, e);
      classificationResult = {
        classification: 'non-productive',
        justification: 'Error parsing AI response.'
      };
    }
    
    console.log(`Domain classified: ${domain} as ${classificationResult.classification}`);
    
    return res.status(200).json({ 
      classification: classificationResult.classification,
      justification: classificationResult.justification,
      domain: domain
    });
  } catch (error) {
    console.error('Error classifying domain:', error);
    return res.status(500).json({ error: 'Error processing domain classification request' });
  }
});

// YouTube video analysis endpoint
app.post('/api/analyze-youtube', async (req, res) => {
  try {
    const { title, description, channelName } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Video title is required' });
    }
    
    const analysis = await analyzeYouTubeVideo(title, description || '', channelName || '');
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing YouTube video:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
