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

  try {
    // Special prompt for YouTube titles
    if (url.includes('youtube.com') || title.includes('YouTube')) {
      const prompt = `
        Analyze this YouTube video title: "${title}"

        Return JSON:
        - isProductive (bool)
        - score (0–100)
        - categories (array of words)
        - explanation (string)
    
        CLASSIFICATION RULES:
        1. ALL educational content MUST be classified as productive (score 75-100)
        2. ALL academic content (math, science, engineering, etc.) MUST be classified as productive
        3. ALL lectures, courses, tutorials, lessons MUST be classified as productive
        4. Content from educational channels MUST be classified as productive
        5. Content about linear algebra, vectors, matrices, calculus, physics, biology, history, etc. MUST be productive
        
        EXAMPLES OF PRODUCTIVE YOUTUBE CONTENT:
        - Math lectures and explanations (like linear algebra, vectors, matrices)
        - Science videos and documentaries
        - How-to guides and tutorials
        - University lectures
        - Programming tutorials
        - Historical documentaries
        - Educational animations
        - Academic explanations
        - Language learning videos
        
        When in doubt about educational value, classify as productive.
      `;
      
      // Make request to Gemini API
      const result = await model.generateContent(prompt);
      const response = result.response;
      return processGeminiTitleResponse(response);
    }
    
    // Standard prompt for non-YouTube titles
    const prompt = `
      Classify tab title: "${title}"

      Return JSON:
      - isProductive (bool)
      - score (0–100)
      - categories (array of words)
      - explanation (string)
  
      Productive if:
      1. Educational content (math, science, history, programming, tutorials, lectures, etc.)
      2. Professional development (job search, career resources, skill building)
      3. Work-related tools and platforms (project management, coding, documentation, AI)
      4. Research or academic topics
      5. Productivity tools and resources
      6. Email is always productive
      
      Be generous in classifying educational content as productive, even if it's entertaining.
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

/**
 * Process Gemini response for title analysis
 * @param {Object} response - Gemini API response
 * @returns {Object} - Processed response
 */
function processGeminiTitleResponse(response) {
  try {
    let responseText = response.text();

    // Check if the response is valid JSON by removing markdown formatting if present
    if (responseText.includes('```json')) {
      responseText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      responseText = responseText.split('```')[1].split('```')[0].trim();
    }

    // Try to parse JSON
    try {
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
    } catch (jsonError) {
      console.error('Error parsing JSON from title analysis:', jsonError);
      
      // If can't parse JSON, fallback to text analysis
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
  } catch (error) {
    console.error('Error processing title response:', error);
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error processing analysis'
    };
  }
}

/**
 * Process Gemini response into a standardized format
 * @param {Object} result - Gemini API response
 * @param {Object} res - Express response object
 * @returns {Object} - Processed response
 */
function processGeminiResponse(result, res) {
  try {
    const analysis = result?.text()?.trim() || '';
    
    // Try to parse JSON from the response
    let jsonResult;
    try {
      // Extract JSON if it's wrapped in markdown code blocks
      if (analysis.includes('```json')) {
        jsonResult = JSON.parse(analysis.split('```json')[1].split('```')[0]);
      } else if (analysis.includes('```')) {
        jsonResult = JSON.parse(analysis.split('```')[1].split('```')[0]);
      } else {
        jsonResult = JSON.parse(analysis);
      }
      
      // Ensure proper format
      if (!jsonResult.classification) {
        jsonResult.isProductive = jsonResult.classification === 'productive';
      } else {
        jsonResult.isProductive = jsonResult.classification === 'productive';
      }
      
      // Normalize score
      if (typeof jsonResult.score === 'string') {
        jsonResult.score = parseFloat(jsonResult.score);
      }
      if (jsonResult.score <= 1 && jsonResult.score >= 0) {
        jsonResult.score = Math.round(jsonResult.score * 100);
      }
      
      return res.status(200).json(jsonResult);
    } catch (parseError) {
      console.error('Error parsing JSON from Gemini response:', parseError);
      
      // Fall back to basic text analysis if JSON parsing fails
      const analysisLower = analysis.toLowerCase();
      let classification = 'unproductive'; // Default
      let explanation = analysis;
      let score = 30;
      let categories = ['Unknown'];
      
      if (analysisLower.includes('productive')) {
        classification = 'productive';
        score = 75;
        categories = ['Work'];
      } else if (analysisLower.includes('unproductive')) {
        classification = 'unproductive';
        score = 25;
        categories = ['Leisure'];
      } else {
        // If neither keyword is found, analyze the text more carefully
        if (
          analysisLower.includes('work') || 
          analysisLower.includes('education') || 
          analysisLower.includes('learning') || 
          analysisLower.includes('professional') ||
          analysisLower.includes('valuable') ||
          analysisLower.includes('useful') ||
          analysisLower.includes('informative') ||
          analysisLower.includes('tutorial') ||
          analysisLower.includes('course') ||
          analysisLower.includes('lecture')
        ) {
          classification = 'productive';
          score = 75;
          categories = ['Education'];
        }
      }
      
      // Return a properly formatted response
      return res.status(200).json({
        classification: classification,
        isProductive: classification === 'productive',
        score: score, 
        categories: categories,
        explanation: explanation.substring(0, 100) // Trim explanation to avoid excessive data
      });
    }
  } catch (error) {
    console.error('Error processing Gemini response:', error);
    return res.status(500).json({ error: 'Error processing content analysis' });
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
    const { title, url, domain } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    
    // Sanitize title
    const cleanTitle = validator.escape(title);
    
    // Pass url to analyzeTabTitle for better YouTube detection
    const analysis = await analyzeTabTitle(cleanTitle, url || '');
    
    // Enhance confidence for YouTube educational content
    if (url && url.includes('youtube.com') && analysis.isProductive) {
      // Educational YouTube content should have high confidence
      if (analysis.score < 75) {
        analysis.score = 75;
      }
      // Add YouTube category if not present
      if (!analysis.categories.includes('YouTube') && !analysis.categories.includes('Education')) {
        analysis.categories.push('Education');
      }
    }
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing title:', error);
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Add new API endpoints for Gemini integration for domain and content classification

// Endpoint for classifying domains with Gemini
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { prompt, domain } = req.body;
    
    if (!prompt || !domain) {
      return res.status(400).json({ error: 'Prompt and domain are required' });
    }
    
    // Use the same gemini model for classification
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    
    const result = response.response;
    let classification = result?.text()?.trim().toLowerCase() || '';
    
    // Ensure classification is one of our expected values
    if (!['always_productive', 'always_unproductive', 'ambiguous'].includes(classification)) {
      // Default to ambiguous if unexpected response
      console.log(`Unexpected Gemini response for domain classification: "${classification}". Defaulting to ambiguous.`);
      classification = 'ambiguous';
    }
    
    // Log the classification for analytics
    console.log(`Gemini classified domain: ${domain} as ${classification}`);
    
    return res.status(200).json({ 
      classification: classification,
      domain: domain
    });
  } catch (error) {
    console.error('Error classifying domain with Gemini:', error);
    return res.status(500).json({ error: 'Error processing domain classification request' });
  }
});

// Endpoint for analyzing content with Gemini
app.post('/api/analyze-content-gemini', async (req, res) => {
  try {
    const { url, title, content, siteName } = req.body;
    
    // Specialized prompt for YouTube content
    if (siteName === 'YouTube' || (url && url.includes('youtube.com'))) {
      const prompt = `
        Analyze this YouTube content and classify it as either "productive" or "unproductive".
        
        URL: ${url}
        Title: ${title}
        Content: ${content ? content.substring(0, 1500) : 'No content provided'}
        
        Return JSON format:
        {
          "classification": "productive" or "unproductive",
          "score": number between 0-100,
          "categories": ["category1", "category2"],
          "explanation": "Reason for classification"
        }
        
        IMPORTANT CLASSIFICATION RULES FOR YOUTUBE:
        1. ALL educational content MUST be classified as "productive" (score 75-100)
        2. ALL academic content (math, science, engineering, etc.) MUST be classified as "productive"
        3. ALL lectures, courses, tutorials, lessons MUST be classified as "productive"
        4. Content from educational channels (universities, professors, educational creators) MUST be classified as "productive"
        5. Content about linear algebra, vectors, matrices, calculus, physics, biology, history, language learning, etc. MUST be classified as "productive"
        
        EXAMPLES OF PRODUCTIVE YOUTUBE CONTENT:
        - Math lectures and explanations (like linear algebra, vectors, matrices)
        - Science videos and documentaries
        - How-to guides and tutorials
        - University lectures
        - Programming tutorials
        - Historical documentaries
        - Educational animations
        - Academic explanations
        - Language learning videos
        - Educational channels like Khan Academy, 3Blue1Brown, MIT OpenCourseWare, etc.
        
        When in doubt about educational value, classify as "productive".
      `;
      
      // Use the gemini model for YouTube content analysis
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }]}]
      });
      
      const result = response.response;
      return processGeminiResponse(result, res);
    }
    
    // Standard prompt for other content
    const prompt = `
      Classify the following web content as either "productive" or "unproductive":
      
      URL: ${url}
      Title: ${title}
      ${siteName ? 'Site: ' + siteName : ''}
      Content: ${content ? content.substring(0, 1000) : 'No content provided'}
      
      Return JSON format:
      {
        "classification": "productive" or "unproductive",
        "score": number between 0-100,
        "categories": ["category1", "category2"],
        "explanation": "Reason for classification"
      }
      
      Productive content includes:
      1. Educational content, tutorials, learning materials
      2. Professional development, career resources
      3. Work-related tools and documentation
      4. Research and academic topics
      5. Productivity tools and resources
      
      Be generous in classifying educational content as productive, even if it's entertaining.
    `;
    
    // Use the gemini model for content analysis
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    
    const result = response.response;
    const analysis = result?.text()?.trim() || '';
    
    // Try to parse JSON from the response
    let jsonResult;
    try {
      // Extract JSON if it's wrapped in markdown code blocks
      if (analysis.includes('```json')) {
        jsonResult = JSON.parse(analysis.split('```json')[1].split('```')[0]);
      } else if (analysis.includes('```')) {
        jsonResult = JSON.parse(analysis.split('```')[1].split('```')[0]);
      } else {
        jsonResult = JSON.parse(analysis);
      }
      
      return res.status(200).json(jsonResult);
          } catch (parseError) {
        console.error('Error parsing JSON from Gemini response:', parseError);
        
        // Fall back to basic text analysis if JSON parsing fails
        const analysisLower = analysis.toLowerCase();
        let classification = 'unproductive'; // Default
        let explanation = analysis;
        let score = 30;
        let categories = ['Unknown'];
        
        if (analysisLower.includes('productive')) {
          classification = 'productive';
          score = 75;
          categories = ['Work'];
        } else if (analysisLower.includes('unproductive')) {
          classification = 'unproductive';
          score = 25;
          categories = ['Leisure'];
        } else {
          // If neither keyword is found, analyze the text more carefully
          if (
            analysisLower.includes('work') || 
            analysisLower.includes('education') || 
            analysisLower.includes('learning') || 
            analysisLower.includes('professional') ||
            analysisLower.includes('valuable') ||
            analysisLower.includes('useful') ||
            analysisLower.includes('informative') ||
            analysisLower.includes('tutorial') ||
            analysisLower.includes('course') ||
            analysisLower.includes('lecture')
          ) {
            classification = 'productive';
            score = 75;
            categories = ['Education'];
          }
        }
        
        // Return a properly formatted response
                return res.status(200).json({
          classification: classification,
          score: score, 
          categories: categories,
          explanation: explanation.substring(0, 100) // Trim explanation to avoid excessive data
        });
      }
  } catch (error) {
    console.error('Error analyzing content with Gemini:', error);
    return res.status(500).json({ error: 'Error processing content analysis request' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
