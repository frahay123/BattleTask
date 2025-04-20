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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Gemini API configuration
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Middleware
app.use(cors());
app.use(bodyParser.json());

/**
 * Analyze a tab title to determine if it's educational content
 */
async function analyzeTabTitle(title) {
  if (!title || title.trim() === '' || title === 'New Tab') {
    return {
      isEducational: false,
      score: 0,
      categories: [],
      explanation: ''
    };
  }

  try {
    // Create prompt for Gemini
    const prompt = `
      Analyze this browser tab title: "${title}"
      
      Determine if this title suggests educational content. Consider these factors:
      1. Educational subjects (math, science, history, programming, etc.)
      2. Learning resources (tutorials, guides, courses, etc.)
      3. Educational institutions (universities, schools, etc.)
      4. Research or academic topics
      
      Return a JSON object with these fields:
      - isEducational (boolean): true if it's likely educational content
      - score (float between 0 and 1): how confident the content is educational
      - categories (array of strings): educational categories that match, if any
      - explanation (string): brief explanation of why it's educational or not
      
      Just return the JSON object, nothing else.
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
    if (!analysis.isEducational) analysis.isEducational = false;
    if (!analysis.score) analysis.score = 0.0;
    if (!analysis.categories) analysis.categories = [];
    if (!analysis.explanation) analysis.explanation = '';

    return analysis;
  } catch (error) {
    console.error('Error analyzing title:', error);
    return {
      isEducational: false,
      score: 0,
      categories: [],
      explanation: 'Error during analysis'
    };
  }
}

// API Routes

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BattleTask Backend Server is running' });
});

// Save tab data and analyze educational content
app.post('/api/tabs', async (req, res) => {
  try {
    const { windowId, tab } = req.body;

    if (!tab || !tab.title) {
      return res.status(400).json({ success: false, error: 'Tab data is required' });
    }

    // Analyze the tab title for educational content
    const analysis = await analyzeTabTitle(tab.title);
    
    res.json({ 
      success: true, 
      id: tab.id, 
      analysis: {
        isEducational: analysis.isEducational,
        score: analysis.score,
        categories: analysis.categories,
        explanation: analysis.explanation
      }
    });
  } catch (error) {
    console.error('Error processing tab data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Analyze a title directly from the frontend
app.post('/api/analyze-title', async (req, res) => {
  try {
    const { title } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    
    const analysis = await analyzeTabTitle(title);
    
    res.json({
      success: true,
      ...analysis
    });
  } catch (error) {
    console.error('Error analyzing title:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
