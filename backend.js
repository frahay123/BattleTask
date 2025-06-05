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

// General IP-based rate limiting:
// This acts as a broad, initial shield.
const ipLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300, // Max 300 requests per IP per day (can be adjusted)
  message: { success: false, error: 'Too many requests from this IP, try again tomorrow.' },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
app.use('/api/', ipLimiter);

// Per-user/device rate limiting (more specific)
// This will be the primary limiter for identified requests.
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

        Classify strictly as "productive" or "unproductive".
        Provide a concise explanation.
        Assign a score (0-100).
        List relevant categories (1-3 words each).

        RETURN JSON ONLY:
        {
          "isProductive": boolean, // true if productive
          "score": number, // 0-100
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
    }
    
    // Standard prompt for non-YouTube titles
    const prompt = `
      Analyze this tab title: "${title}"
      ${url ? `Associated URL (for context): ${url}` : ''}

      Classify strictly as "productive" or "unproductive".
      Provide a concise explanation.
      Assign a score (0-100).
      List relevant categories (1-3 words each).

      RETURN JSON ONLY:
      {
        "isProductive": boolean, // true if productive
        "score": number, // 0-100
      }

      GUIDELINES FOR "productive" (score generally 60-100):
      1. Educational: Learning materials, articles on academic/technical subjects.
      2. Professional: Work-related tools, industry news, documentation, skill development.
      3. Informative: In-depth news analysis, research papers, well-structured information.
      4. Task-Oriented: Titles indicating email, project management, coding platforms.
      
      Titles suggesting purely entertainment, social media feeds, clickbait, or superficial content are "unproductive".
      If "email" is explicitly in the title, classify as productive.
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

    // Ensure required fields exist and have correct types
    if (typeof analysis.isProductive !== 'boolean') {
        analysis.isProductive = false; // Default if missing or wrong type
    }
    if (typeof analysis.score !== 'number') {
        // Attempt to parse if it's a string, otherwise default
        const parsedScore = parseFloat(analysis.score);
        analysis.score = !isNaN(parsedScore) ? parsedScore : 0;
    }
    
    // Normalize score to 0-100 range
    // The prompt asks for 0-100, but this handles deviations
    if (analysis.score <= 1 && analysis.score >= 0 && analysis.score !== 0 && analysis.score !== 1) { // check if it is float between 0 and 1 but not 0 or 1
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
    const responseText = result?.text()?.trim() || '';
    
    // Try to parse JSON from the response
    let jsonResult;
    try {
      // Extract JSON if it's wrapped in markdown code blocks
      if (responseText.includes('```json')) {
        jsonResult = JSON.parse(responseText.split('```json')[1].split('```')[0]);
      } else if (responseText.includes('```')) {
        jsonResult = JSON.parse(responseText.split('```')[1].split('```')[0]);
      } else {
        jsonResult = JSON.parse(responseText);
      }
      
      // Ensure proper format
      if (typeof jsonResult.classification !== 'string' || !['productive', 'unproductive'].includes(jsonResult.classification)) {
        // Fallback or error if classification is missing or invalid
        console.warn('Invalid or missing classification in Gemini JSON response. Defaulting. Response:', responseText);
        jsonResult.classification = 'unproductive'; // Default
      }
      jsonResult.isProductive = jsonResult.classification === 'productive';
      
      // Normalize score
      if (typeof jsonResult.score !== 'number') {
        const parsedScore = parseFloat(jsonResult.score);
        jsonResult.score = !isNaN(parsedScore) ? parsedScore : 30; // Default score if parsing fails
      }

      if (jsonResult.score <= 1 && jsonResult.score >= 0 && jsonResult.score !== 0 && jsonResult.score !== 1) {
        jsonResult.score = Math.round(jsonResult.score * 100);
      } else {
        jsonResult.score = Math.min(100, Math.max(0, jsonResult.score));
      }

      if (!Array.isArray(jsonResult.categories)) {
        jsonResult.categories = ['Unknown'];
      }
      if (typeof jsonResult.explanation !== 'string') {
        jsonResult.explanation = 'No explanation provided.';
      }
      
      return res.status(200).json(jsonResult);
    } catch (parseError) {
      console.error('Error parsing JSON from Gemini response:', parseError);
      
      // Fall back to basic text analysis if JSON parsing fails
      const analysisLower = responseText.toLowerCase();
      let classification = 'unproductive'; // Default
      let explanation = responseText;
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
    const { domain } = req.body; // Expect only domain from client
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    const prompt = `
      Analyze domain: "${domain}"
      Classify STRICTLY as "always_productive", "always_unproductive", or "ambiguous".
      "ambiguous" is RARE: for clear, balanced DUAL primary purposes ONLY (e.g., YouTube: education/entertainment).
      Prioritize DOMINANT purpose. Justify briefly.

      RETURN JSON ONLY:
      {
        "classification": "chosen_classification_value", 
      }

      RULES:

      "always_productive":
      - Education: university, online courses, research, Wikipedia, Khan Academy.
      - Work/Career/Business: SaaS tools, GitHub, LinkedIn, finance tools, B2B, money-making ventures, professional news.
      - Essential Info: government sites, technical documentation.
      - Factual News (source focus): Reuters, Associated Press.

      "always_unproductive":
      - Entertainment: streaming (Netflix, not pure ed-platforms), games, celebrity gossip, comics.
      - Sports: ESPN, talksport.com.
      - Social Media (leisure focus): Facebook, Instagram, TikTok, Pinterest.
      - Shopping (personal consumer goods): Amazon, eBay, fashion retail.
      - Hobby Forums (non-work/education).
      - Gambling/Betting.

      "ambiguous": (Use sparingly)
      - Mixed primary uses like YouTube (education/entertainment), Reddit (diverse subs).
      - Major broad news sites (BBC, NYTimes) if significant entertainment/lifestyle sections balance hard news.

      EXAMPLES:
      Domain: "github.com" -> {"classification": "always_productive", "justification": "Software dev & collab."}
      Domain: "coursera.org" -> {"classification": "always_productive", "justification": "Online courses."}
      Domain: "forbes.com" -> {"classification": "always_productive", "justification": "Business & finance news."}
      
      Domain: "talksport.com" -> {"classification": "always_unproductive", "justification": "Sports news/entertainment."}
      Domain: "tiktok.com" -> {"classification": "always_unproductive", "justification": "Short video entertainment."}
      Domain: "amazon.com" -> {"classification": "always_unproductive", "justification": "E-commerce shopping."}
      Domain: "cnn.com" -> {"classification": "ambiguous", "justification": "Broad news, opinion, lifestyle."}

      Analyze: "${domain}"
    `;
    
    // Use the same gemini model for classification
    const response = await model.generateContent({ // Pass as object for new API
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

      // Ensure classification is one of our expected values
      if (!['always_productive', 'always_unproductive', 'ambiguous'].includes(classificationResult.classification)) {
        console.warn(`Unexpected Gemini response for domain classification: "${classificationResult.classification}". Defaulting to ambiguous for domain: ${domain}`);
        classificationResult.classification = 'ambiguous';
        classificationResult.justification = classificationResult.justification || 'Unexpected response from AI.';
      }
    } catch (e) {
      console.error(`Error parsing JSON for domain classification (${domain}):`, e, "Response text:", responseText);
      classificationResult = {
        classification: 'ambiguous', // Default on error
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

// Endpoint for analyzing content with Gemini
app.post('/api/analyze-content-gemini', async (req, res) => {
  try {
    const { url, title, content, siteName, channelName } = req.body;
    let prompt;
    
    // Specialized prompt for YouTube content
    if (siteName === 'YouTube' || (url && url.includes('youtube.com'))) {
      prompt = `
        Analyze the YouTube content below.

        URL: ${url || 'N/A'}
        Title: ${title || 'N/A'}
        ${channelName ? `Channel: ${channelName}` : ''}
       

        Classify strictly as "productive" or "unproductive".
        Provide a concise explanation.
        Assign a score (0-100).
        List relevant categories (1-3 words each).

        RETURN JSON ONLY:
        {
          "classification": "productive" | "unproductive",
          "score": number, // 0-100
        }

        CRITICAL RULES FOR "productive" (score 75-100):
        1. Educational: Lectures, tutorials, documentaries, academic lessons (math, science, history, programming, languages, etc.).
        2. Skill Development: How-to guides, professional skills.
        3. Informative: News from reputable sources (if context suggests informational intent), detailed explanations.

        If content matches any CRITICAL RULE, it IS "productive".
        Entertainment-focused content (music videos, vlogs unless clearly educational, gaming, comedy skits) is "unproductive".
        When educational value is genuinely ambiguous AFTER applying rules, lean slightly towards "productive" if it seems informational.
      `;
    } else {
      // Standard prompt for other content
      prompt = `
        Analyze the web content below.

        URL: ${url || 'N/A'}
        Title: ${title || 'N/A'}
        ${siteName ? 'Site: ' + siteName : ''}
       

        Classify strictly as "productive" or "unproductive".
        Provide a concise explanation.
        Assign a score (0-100).
        List relevant categories (1-3 words each).

        RETURN JSON ONLY:
        {
          "classification": "productive" | "unproductive",
          "score": number, // 0-100
        }

        GUIDELINES FOR "productive" (score generally 60-100):
        1. Educational: Learning materials, articles on academic/technical subjects.
        2. Professional: Work-related tools, industry news, documentation, skill development.
        3. Informative: In-depth news analysis, research papers, well-structured information.
        4. Task-Oriented: Sites for specific tasks like email, project management, coding platforms.
        
        Purely entertainment, social media feeds (unless specific professional context), clickbait, or superficial content is "unproductive".
        If "email" is in title or site, classify as productive.
      `;
    }
    
    // Use the gemini model for content analysis
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    
    const result = response.response;
    return processGeminiResponse(result, res); // Simplified: always use processGeminiResponse

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
