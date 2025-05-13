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
async function analyzeTabTitle(title, url, domain) {
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
Classify tab: "${title}" (URL: ${url}, Domain: ${domain})

Return JSON:
- isProductive (bool)
- score (0-100)
- categories (array)
- explanation (string)
- domainCategory ("always-productive", "always-nonproductive", "context-dependent")
- domainReason (string)

Productive if:
1. Educational content
2. Professional development
3. Work tools
4. Research
5. Productivity tools
6. Email

Context notes:
- youtube.com: context-dependent
- docs.google.com: always-productive
- netflix.com: always-nonproductive
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
    
    // Add domain categorization if not present
    if (!analysis.domainCategory) {
      if (analysis.score >= 80) {
        analysis.domainCategory = 'always-productive';
        analysis.domainReason = 'Domain appears to contain primarily productive content';
      } else if (analysis.score <= 20) {
        analysis.domainCategory = 'always-nonproductive';
        analysis.domainReason = 'Domain appears to contain primarily non-productive content';
      } else {
        analysis.domainCategory = 'context-dependent';
        analysis.domainReason = 'Domain can contain both productive and non-productive content';
      }
    }

    return analysis;
  } catch (error) {
    console.error('Error analyzing title:', error);
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error during analysis',
      domainCategory: 'context-dependent',
      domainReason: 'Unable to categorize domain due to analysis error'
    };
  }
}

// Analyze content directly from the frontend or browser extension
app.post('/api/analyze-content', async (req, res) => {
  try {
    const { title, url, content } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ success: false, error: 'Title and content are required' });
    }
    
    // Sanitize inputs
    const cleanTitle = validator.escape(title);
    
    // Extract domain
    const domain = url ? extractDomain(url) : '';
    
    // Analyze the content for productive status
    const analysis = await analyzeContent(cleanTitle, content, url || '', domain);
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing content:', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

/**
 * Analyze content to determine if it's productive
 * @param {string} title - The title of the page
 * @param {string} content - The content to analyze
 * @param {string} url - The URL of the page
 * @param {string} domain - The domain of the page
 * @returns {Object} Analysis result
 */
async function analyzeContent(title, content, url = '', domain = '') {
  try {
    if (!title || !content) {
      console.error("Missing title or content for analysis");
      return {
        isProductive: false,
        score: 0,
        categories: [],
        explanation: "Unable to analyze: Missing title or content",
        domainCategory: "unknown",
        domainReason: "Insufficient data for domain categorization"
      };
    }

    // Limit content length to avoid token limits
    const truncatedContent = content.substring(0, 2000);
    
    // Create prompt for the model
    const prompt = `
Analyze: "${title}" (Domain: ${domain})

Content: "${truncatedContent}"

Return JSON:
- isProductive (bool)
- score (0-1)
- categories (array)
- explanation (string)
- domainCategory (string)
- domainReason (string)
    `;

    // Call the Gemini API
    const result = await model.generateContent(prompt);

    try {
      const responseText = result.response.text();
      // Extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const analysisResult = JSON.parse(jsonMatch[0]);
        return {
          isProductive: analysisResult.isProductive || false,
          score: analysisResult.score || 0,
          categories: analysisResult.categories || [],
          explanation: analysisResult.explanation || "No explanation provided",
          domainCategory: analysisResult.domainCategory || "unknown",
          domainReason: analysisResult.domainReason || "No domain categorization reason provided"
        };
      } else {
        throw new Error("Failed to extract JSON from API response");
      }
    } catch (parseError) {
      console.error("Error parsing content analysis result:", parseError);
      // Fall back to title-only analysis
      return await analyzeTabTitle(title, url, domain);
    }
  } catch (error) {
    console.error("Error in content analysis:", error);
    // Fall back to title-only analysis as a backup
    return await analyzeTabTitle(title, url, domain);
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
    
    // Extract domain
    const domain = extractDomain(tab.url);

    // Analyze the tab title for productive content
    const analysis = await analyzeTabTitle(cleanTitle, tab.url, domain);
    
    res.json({ 
      success: true, 
      id: tab.id, 
      analysis: {
        isProductive: analysis.isProductive,
        score: analysis.score,
        categories: analysis.categories,
        explanation: analysis.explanation,
        domainCategory: analysis.domainCategory,
        domainReason: analysis.domainReason
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
    const { title, url, domain } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    // Sanitize title
    const cleanTitle = validator.escape(title);
    
    // Use the provided domain or extract it from URL
    const extractedDomain = domain || (url ? extractDomain(url) : '');
    
    const analysis = await analyzeTabTitle(cleanTitle, url || '', extractedDomain);
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing title:', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

/**
 * Extract domain from a URL
 * @param {string} url - The URL to extract domain from
 * @returns {string} The extracted domain
 */
function extractDomain(url) {
  try {
    if (!url) return '';
    
    // Remove protocol and get the hostname
    let domain = url.replace(/(https?:\/\/)?(www\.)?/i, '');
    
    // Remove path and query string
    domain = domain.split('/')[0];
    
    // Remove port if present
    domain = domain.split(':')[0];
    
    return domain;
  } catch (error) {
    console.error('Error extracting domain:', error);
    return '';
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
