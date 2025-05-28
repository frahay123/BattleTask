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
async function analyzeTabTitle(title, url = '') {
  if (!title || title.trim() === '' || title === 'New Tab') {
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: ''
    };
  }

  // Simplified prompt for all titles
  const prompt = `
    Title: "${title}"
    Productive or unproductive?
    JSON: {"classification": "productive" | "unproductive", "score": number}
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    let responseText = response.text();

    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }

    const analysis = JSON.parse(responseText);

    const isProductive = analysis.classification === 'productive';
    let score = 0;
    if (typeof analysis.score === 'number') {
      score = Math.min(100, Math.max(0, analysis.score));
    } else if (typeof analysis.score === 'string') {
      const parsedScore = parseFloat(analysis.score);
      score = !isNaN(parsedScore) ? Math.min(100, Math.max(0, parsedScore)) : 0;
    }
     if (score <= 1 && score >= 0 && score !== 0 && score !== 1) { // handle 0-1 float
      score = Math.round(score * 100);
    }


    return {
      isProductive: isProductive,
      score: score,
      categories: [], // Default empty array
      explanation: '' // Default empty string
    };

  } catch (error) {
    console.error('Error analyzing title with simplified prompt:', error);
    // Fallback for simpler prompt if JSON parsing fails or other error
    const lowerTitle = title.toLowerCase();
    const productiveKeywords = ['learn', 'tutorial', 'course', 'study', 'work', 'document', 'project', 'code', 'develop', 'research', 'news', 'article', 'email'];
    let isProductive = productiveKeywords.some(kw => lowerTitle.includes(kw));
    // Assign a very basic score based on keyword match
    let score = isProductive ? 60 : 20;

    if (url.includes('youtube.com')) {
        const educationalYouTubeKeywords = ['lecture', 'educational', 'how to', 'documentary', 'science', 'math', 'history', 'programming tutorial'];
        if (educationalYouTubeKeywords.some(kw => lowerTitle.includes(kw))) {
            isProductive = true;
            score = 85; // Higher score for clearly educational YouTube
        } else {
            // For YouTube, if not clearly educational by title, assume less productive by default with this simple model
            // isProductive might already be true from generic keywords, but we can be more conservative
            if (!isProductive) score = 10; // Lower score for generic YouTube titles
        }
    }


    return {
      isProductive: isProductive,
      score: score,
      categories: [],
      explanation: 'Error during simplified analysis, using fallback'
    };
  }
}

/**
 * Process Gemini response for title analysis - ADAPTED FOR SIMPLIFIED PROMPT
 * This function might be less used if analyzeTabTitle handles parsing directly,
 * but kept for structure or if called from elsewhere with a similar simple response.
 */
function processGeminiTitleResponse(response) {
  try {
    let responseText = response.text();

    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }

    const analysis = JSON.parse(responseText);

    const isProductive = analysis.classification === 'productive';
    let score = 0;
    if (typeof analysis.score === 'number') {
      score = Math.min(100, Math.max(0, analysis.score));
    } else if (typeof analysis.score === 'string') {
      const parsedScore = parseFloat(analysis.score);
      score = !isNaN(parsedScore) ? Math.min(100, Math.max(0, parsedScore)) : 0;
    }
    if (score <= 1 && score >= 0 && score !== 0 && score !== 1) { // handle 0-1 float
        score = Math.round(score * 100);
    }


    return {
      isProductive: isProductive,
      score: score,
      categories: [], // Default empty
      explanation: ''   // Default empty
    };

  } catch (jsonError) {
    console.error('Error parsing JSON from simplified title analysis:', jsonError);
    return {
      isProductive: false,
      score: 10, // Low score on error
      categories: [],
      explanation: 'Error parsing AI response for title'
    };
  }
}

/**
 * Process Gemini response into a standardized format - ADAPTED FOR SIMPLIFIED PROMPT
 * @param {Object} result - Gemini API response
 * @param {Object} res - Express response object
 * @returns {Object} - Processed response for Express
 */
function processGeminiResponse(result, res) { // Note: 'res' Express object is passed here.
  try {
    const responseText = result?.text()?.trim() || '';
    let jsonResult;

    try {
      if (responseText.includes('```json')) {
        jsonResult = JSON.parse(responseText.split('```json')[1].split('```')[0]);
      } else if (responseText.includes('```')) {
        jsonResult = JSON.parse(responseText.split('```')[1].split('```')[0]);
      } else {
        jsonResult = JSON.parse(responseText);
      }

      const classification = jsonResult.classification;
      const isProductive = classification === 'productive';
      
      let score = 0;
      if (typeof jsonResult.score === 'number') {
        score = Math.min(100, Math.max(0, jsonResult.score));
      } else if (typeof jsonResult.score === 'string') {
        const parsedScore = parseFloat(jsonResult.score);
        score = !isNaN(parsedScore) ? Math.min(100, Math.max(0, parsedScore)) : 0;
      }
      if (score <= 1 && score >= 0 && score !== 0 && score !== 1) { // handle 0-1 float
        score = Math.round(score * 100);
      }


      return res.status(200).json({
        classification: classification,
        isProductive: isProductive,
        score: score,
        categories: [], // Default empty
        explanation: ''   // Default empty
      });

    } catch (parseError) {
      console.error('Error parsing JSON from simplified Gemini response:', parseError, "Response text:", responseText);
      // Fallback to basic text analysis if JSON parsing fails with the simplified prompt
      const analysisLower = responseText.toLowerCase();
      let classification = 'unproductive'; // Default
      let score = 20; // Default score
      
      if (analysisLower.includes('productive')) {
        classification = 'productive';
        score = 70;
      }
      // No explicit 'unproductive' check, default is unproductive.

      return res.status(200).json({
        classification: classification,
        isProductive: classification === 'productive',
        score: score,
        categories: [],
        explanation: 'Simplified AI response parsing error, used fallback text analysis.'
      });
    }
  } catch (error) {
    console.error('Error processing simplified Gemini response:', error);
    return res.status(500).json({ 
        isProductive: false, 
        score: 0, 
        categories: [], 
        explanation: 'Error processing content analysis',
        error: 'Error processing content analysis' // Keep error field for client
    });
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
    if (!validator.isURL(tab.url, { require_protocol: true })) {
      return res.status(400).json({ success: false, error: 'Invalid URL' });
    }
    const cleanTitle = validator.escape(tab.title);

    // Analyze the tab title using the simplified version
    const analysis = await analyzeTabTitle(cleanTitle, tab.url); // Pass URL for context in fallback
    
    res.json({ 
      success: true, 
      id: tab.id, 
      analysis: { // Ensure this structure is maintained for the client
        isProductive: analysis.isProductive,
        score: analysis.score,
        categories: analysis.categories, // Will be []
        explanation: analysis.explanation // Will be '' or error message
      }
    });
  } catch (error) {
    console.error('Error processing tab data (simplified):', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Analyze a title directly from the frontend
app.post('/api/analyze-title', async (req, res) => {
  try {
    const { title, url } = req.body; // Domain not used in this simplified version
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    
    const cleanTitle = validator.escape(title);
    const analysis = await analyzeTabTitle(cleanTitle, url || ''); // Pass URL for context in fallback
    
    // No specific YouTube enhancement here as analyzeTabTitle's fallback has some basic YouTube logic
    
    res.json({
      success: true,
      isProductive: analysis.isProductive,
      score: analysis.score,
      categories: analysis.categories, // Will be []
      explanation: analysis.explanation, // Will be '' or error message
      // classification field is not part of this specific endpoint's defined response,
      // but isProductive covers the core need.
    });
  } catch (error) {
    console.error('Error analyzing title (simplified):', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});


// Endpoint for classifying domains with Gemini (SIMPLIFIED)
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    const prompt = `
      Domain: "${domain}"
      This is for chrome extension to classify the domain as productive or unproductive. Be strict and only choose ambigious if absolutely necessary.
      Classification: "productive", "unproductive", or "ambiguous"?
      JSON: {"classification": "productive" | "unproductive" | "ambiguous"}
    `;
    
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    
    const result = response.response;
    let responseText = result?.text()?.trim() || '';
    let classificationResult = { classification: 'ambiguous' }; // Default

    try {
      if (responseText.includes('```json')) {
        responseText = responseText.split('```json')[1].split('```')[0].trim();
      } else if (responseText.includes('```')) {
        responseText = responseText.split('```')[1].split('```')[0].trim();
      }
      const parsedJson = JSON.parse(responseText);

      if (['productive', 'unproductive', 'ambiguous'].includes(parsedJson.classification)) {
        classificationResult.classification = parsedJson.classification;
      } else {
        console.warn(`Unexpected Gemini classification for domain: "${parsedJson.classification}". Defaulting to ambiguous for ${domain}.`);
      }
    } catch (e) {
      console.error(`Error parsing JSON for domain classification (${domain}):`, e, "Response text:", responseText);
      // classificationResult remains 'ambiguous' as set by default
      // Basic text fallback for domain if JSON fails completely
      const lowerDomain = domain.toLowerCase();
      if (lowerDomain.includes('github') || lowerDomain.includes('stackoverflow') || lowerDomain.includes('medium') || lowerDomain.includes('wikipedia') || lowerDomain.includes('edu') || lowerDomain.includes('gov')) {
        classificationResult.classification = 'productive';
      } else if (lowerDomain.includes('tiktok') || lowerDomain.includes('facebook') || lowerDomain.includes('instagram') || lowerDomain.includes('twitter') || lowerDomain.includes('game')) {
        classificationResult.classification = 'unproductive';
      }
    }
        
    console.log(`Gemini classified domain (simplified): ${domain} as ${classificationResult.classification}`);
    
    return res.status(200).json({ 
      classification: classificationResult.classification,
      // justification: '', // No longer requested from AI
      domain: domain
    });
  } catch (error) {
    console.error('Error classifying domain with Gemini (simplified):', error);
    return res.status(500).json({ error: 'Error processing domain classification request', classification: 'ambiguous' });
  }
});

// Endpoint for analyzing content with Gemini (SIMPLIFIED)
app.post('/api/analyze-content-gemini', async (req, res) => {
  try {
    const { url, title, content, siteName } = req.body; // siteName might offer little value now
    
    const prompt = `
      Content Analysis:
      Title: ${title || 'N/A'}
      URL: ${url || 'N/A'}
      Snippet: ${content ? content.substring(0, 500) : 'N/A'} 
      Productive or unproductive? Be strict and carefully think about the content to decide if for a chrome extension that tracks productivity what the content should be classified as. 
      JSON: {"classification": "productive" | "unproductive", "score": number}
    `;
        
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    
    const result = response.response;
    return processGeminiResponse(result, res); // Use the adapted processGeminiResponse

  } catch (error) {
    console.error('Error analyzing content with Gemini (simplified):', error);
    // Ensure the response structure from processGeminiResponse (error case) is used
     return res.status(500).json({ 
        isProductive: false, 
        score: 0, 
        categories: [], 
        explanation: 'Error processing simplified content analysis request',
        error: 'Error processing simplified content analysis request' 
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
