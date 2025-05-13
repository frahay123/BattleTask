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
    // Validate URL
    if (!validator.isURL(tab.url, { require_protocol: true })) {
      return res.status(400).json({ success: false, error: 'Invalid URL' });
    }
    // Sanitize title
    const cleanTitle = validator.escape(tab.title);

    // Analyze the tab title for productive content
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

// --- Domain-level classification endpoint ---
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) {
      return res.status(400).json({ success: false, error: 'Domain is required' });
    }
    // Construct Gemini prompt for domain-level classification
    const prompt = `For the domain: ${domain}\n\nCan this domain ever be unproductive for a user?\n- If it is always productive (e.g., only work tools), reply: {\"onlyProductive\": true, \"onlyNonProductive\": false}\n- If it is always non-productive (e.g., only entertainment), reply: {\"onlyProductive\": false, \"onlyNonProductive\": true}\n- If it can be both, reply: {\"onlyProductive\": false, \"onlyNonProductive\": false}\n\nReply only with the JSON object.`;
    const result = await model.generateContent(prompt);
    let responseText = result.response.text();
    // Extract JSON from response
    let jsonMatch = responseText.match(/\{[\s\S]*\}/);
    let data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    // Fallback defaults
    if (typeof data.onlyProductive !== 'boolean') data.onlyProductive = false;
    if (typeof data.onlyNonProductive !== 'boolean') data.onlyNonProductive = false;
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error in /api/classify-domain:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- URL-level classification endpoint ---
app.post('/api/classify-url', async (req, res) => {
  try {
    const { url, domain, title, content } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    // Construct Gemini prompt for URL-level classification
    const prompt = `Classify the following web page for productivity.\n\nURL: ${url}\nDomain: ${domain || ''}\nTitle: ${title || ''}\nContent: ${content || ''}\n\nReturn JSON:\n- isProductive (bool)\n- score (0–100)\n- categories (array of strings)\n- explanation (string)\n`;
    const result = await model.generateContent(prompt);
    let responseText = result.response.text();
    // Extract JSON from response
    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }
    const analysis = JSON.parse(responseText);
    // Normalize fields
    if (!analysis.isProductive) analysis.isProductive = false;
    if (!analysis.score && analysis.score !== 0) analysis.score = 0;
    if (typeof analysis.score === 'string') analysis.score = parseFloat(analysis.score);
    if (analysis.score <= 1 && analysis.score >= 0) analysis.score = Math.round(analysis.score * 100);
    else analysis.score = Math.min(100, Math.max(0, analysis.score));
    if (!analysis.categories) analysis.categories = [];
    if (!analysis.explanation) analysis.explanation = '';
    res.json({ success: true, ...analysis });
  } catch (error) {
    console.error('Error in /api/classify-url:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});

module.exports = app;
