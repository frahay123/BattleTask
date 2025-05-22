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

// Domain classification cache (can be replaced with DB later)
const domainCache = {};

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

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Rate limiting: 300 requests per IP per day
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300,
  message: { success: false, error: 'Too many requests from this IP, try again tomorrow.' }
});
app.use('/api/', ipLimiter);

// Per-user rate limiting (based on user ID, if provided)
const userLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => {
    // Use tab.id, or a userId field, or fallback to IP
    if (req.body && req.body.tab && req.body.tab.id) return 'user-' + req.body.tab.id;
    if (req.body && req.body.userId) return 'user-' + req.body.userId;
    return req.ip;
  },
  message: { success: false, error: 'Too many requests for this user, try again tomorrow.' }
});
app.use('/api/', userLimiter);

/**
 * Analyze a tab title to determine if it's productive content
 */
async function analyzeTabTitle(title) {
  if (!title || title.trim() === '' || title === 'New Tab') {
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: ''
    };
  }

  try {
    // Create prompt for Gemini
    const prompt = `
      Classify tab title: "${title}"

      Return JSON:
      - isProductive (bool)
      - score (0–100)
      - categories (word)
  

      Productive if:
      1. Educational content (math, science, history, programming, etc.)
      2. Professional development (job search, career resources, skill building)
      3. Work-related tools and platforms (project management, coding, documentation, AI)
      4. Research or academic topics
      5. Productivity tools and resources
      6. Email is always productive
    `;

    // Make request to Gemini API
    const result = await model.generateContent(prompt);
    const response = result.response;
    let responseText = response.text();

    // Check if the response is valid JSON by removing markdown formatting if present
    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }

    // Parse the JSON response
    const analysis = JSON.parse(responseText);

    // Ensure required fields exist
    if (!analysis.isProductive) analysis.isProductive = false;
    
    // Handle score normalization
    if (!analysis.score && analysis.score !== 0) analysis.score = 0;
    
    // Convert score to a number if it's a string
    if (typeof analysis.score === 'string') {
      analysis.score = parseFloat(analysis.score);
    }
    
    // Normalize score to 0-100 range
    if (analysis.score <= 1 && analysis.score >= 0) {
      // If score is in 0-1 range (float), multiply by 100
      analysis.score = Math.round(analysis.score * 100);
    } else {
      // Otherwise, cap it at 100
      analysis.score = Math.min(100, Math.max(0, analysis.score));
    }
    
    if (!analysis.categories) analysis.categories = [];
    if (!analysis.explanation) analysis.explanation = '';

    return analysis;
  } catch (error) {
    console.error('Error analyzing title:', error);
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error during analysis'
    };
  }
}

async function classifyDomainWithGemini(domain) {
  const prompt = `
    Given the domain: "${domain}"

    Classify its overall productivity category. Choose one of:
    - always_productive
    - always_unproductive
    - ambiguous

    Definitions:
    - "always_productive": This domain mostly contains educational, work, or research content (e.g. leetcode.com).
    - "always_unproductive": This domain mostly contains entertainment, distractions, or unrelated content (e.g. netflix.com).
    - "ambiguous": This domain hosts both productive and unproductive content depending on the page (e.g. youtube.com).

    Return only:
    {
      "domain": "${domain}",
      "classification": "ambiguous",
      "reason": "Contains both educational videos and entertainment"
    }
  `;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let jsonText = responseText;
    if (jsonText.includes('```json')) {
      jsonText = jsonText.split('```json')[1].split('```')[0].trim();
    } else if (jsonText.includes('```')) {
      jsonText = jsonText.split('```')[1].split('```')[0].trim();
    }

    const parsed = JSON.parse(jsonText);
    if (parsed && parsed.classification) {
      return parsed.classification;
    }
  } catch (err) {
    console.error('Error classifying domain:', err);
  }
  return 'ambiguous'; // default fallback
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

// Save tab data and analyze productive content
app.post('/api/tabs', async (req, res) => {
  try {
    const { windowId, tab } = req.body;

    if (!tab || !tab.title || !tab.id || !tab.url) {
      return res.status(400).json({ success: false, error: 'Tab data is required' });
    }

    if (!validator.isURL(tab.url, { require_protocol: true })) {
      return res.status(400).json({ success: false, error: 'Invalid URL' });
    }

    const cleanTitle = validator.escape(tab.title);
    const domain = new URL(tab.url).hostname.replace(/^www\./, '');

    // Check cached domain classification
    let classification = domainCache[domain];

    if (!classification) {
      classification = await classifyDomainWithGemini(domain);
      domainCache[domain] = classification;
    }

    if (classification === 'always_productive') {
      return res.json({
        success: true,
        id: tab.id,
        analysis: {
          isProductive: true,
          score: 100,
          categories: ['domain'],
          explanation: 'Classified as always productive by domain'
        }
      });
    }

    if (classification === 'always_unproductive') {
      return res.json({
        success: true,
        id: tab.id,
        analysis: {
          isProductive: false,
          score: 0,
          categories: ['domain'],
          explanation: 'Classified as always unproductive by domain'
        }
      });
    }

    // Otherwise, ambiguous — analyze title
    const analysis = await analyzeTabTitle(cleanTitle);

    res.json({
      success: true,
      id: tab.id,
      analysis: {
        isProductive: analysis.isProductive,
        score: analysis.score,
        categories: analysis.categories,
        explanation: analysis.explanation
      }
    });
  } catch (error) {
    console.error('Error processing tab data:', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Analyze a title directly from the frontend
app.post('/api/analyze-title', async (req, res) => {
  try {
    const { title } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    // Sanitize title
    const cleanTitle = validator.escape(title);
    
    const analysis = await analyzeTabTitle(cleanTitle);
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing title:', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
