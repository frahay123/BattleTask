/**
 * Minimal Backend for BattleTask - Two prompts only
 */

require('dotenv').config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.use(cors());
app.use(bodyParser.json());

// Rate limiting by device ID or IP
const rateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 300,
  keyGenerator: (req) => {
    const deviceId = req.headers['x-device-id'];
    return deviceId && validator.isUUID(deviceId) ? `device-${deviceId}` : `ip-${req.ip}`;
  },
  message: { success: false, error: 'Daily API limit exceeded' }
});
app.use('/api/', rateLimiter);

// PROMPT 1: Domain Classification - BULLETPROOF VERSION
const DOMAIN_CLASSIFICATION_PROMPT = `
ANALYZE DOMAIN: "DOMAIN_PLACEHOLDER"

CLASSIFICATION CRITERIA:

ALWAYS_PRODUCTIVE domains (work/education/development):
- Educational:
- Development:
- Documentation: 
- Work Communication:
- Email/Calendar:
- Cloud Storage: 
- Design Tools: 
- Analytics/Admin
- Learning Platforms: 
- Reference: 

ALWAYS_UNPRODUCTIVE domains (entertainment/social/shopping):
- Social Media: 
- Video Entertainment: 
- Gaming: 
- Shopping: 
- News/Media: 
- Sports: 
- Dating: 
- Memes/Fun: 

DECISION LOGIC:
1. Check exact domain matches above
2. Check top-level domain (.edu = productive, .xxx/.adult = unproductive)
3. Check subdomain patterns (docs.* = productive, shop.* = unproductive)
4. If ambiguous, default to "always_unproductive"

RETURN ONLY THIS JSON FORMAT:
{
  "classification": "always_productive" | "always_unproductive"
}

NO explanations, NO other text, ONLY valid JSON.`;

// PROMPT 2: YouTube Analysis - ENHANCED VERSION  
const YOUTUBE_ANALYSIS_PROMPT = `
ANALYZE YOUTUBE VIDEO:
Title: "TITLE_PLACEHOLDER"
Channel: "CHANNEL_PLACEHOLDER"

PRODUCTIVITY SCORING:

PRODUCTIVE (70-100 points):
- Programming: tutorials, coding, software development
- Academic: lectures, educational content, research
- Professional Skills: business, marketing, design tutorials
- Technical Training: certifications, courses, how-to guides
- Language Learning: foreign language instruction
- Science/Math: educational explanations, experiments

UNPRODUCTIVE (0-40 points):
- Entertainment: movies, TV shows, comedy, pranks
- Gaming: gameplay, reviews, streaming
- Sports: highlights, analysis, commentary  
- Music: songs, concerts, music videos
- Lifestyle: vlogs, fashion, travel, food
- News/Politics: current events, commentary
- Gossip/Drama: celebrity content, reactions

SCORING GUIDELINES:
- Educational programming tutorial: 85-95 points
- University lecture: 80-90 points  
- Business/marketing course: 75-85 points
- Sports highlights: 10-20 points
- Music video: 5-15 points
- Gaming content: 5-20 points
- Entertainment/comedy: 0-15 points

WHEN IN DOUBT: Always classify as "unproductive" with 0-30 points.

RETURN ONLY THIS JSON FORMAT:
{
  "classification": "productive" | "unproductive",
  "score": number
}

NO explanations, NO other text, ONLY valid JSON.`;

function parseResponse(text) {
  // Clean up the response text
  let cleanText = text.trim();
  
  // Extract JSON from markdown code blocks
  if (cleanText.includes('```json')) {
    cleanText = cleanText.split('```json')[1].split('```')[0].trim();
  } else if (cleanText.includes('```')) {
    cleanText = cleanText.split('```')[1].split('```')[0].trim();
  }
  
  // Remove any leading/trailing non-JSON content
  const jsonStart = cleanText.indexOf('{');
  const jsonEnd = cleanText.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleanText = cleanText.substring(jsonStart, jsonEnd + 1);
  }
  
  // Parse and validate JSON
  const parsed = JSON.parse(cleanText);
  
  // Validate required fields based on response type
  if (parsed.classification && (parsed.classification === 'always_productive' || parsed.classification === 'always_unproductive')) {
    // Domain classification response
    return parsed;
  } else if (parsed.classification && parsed.score !== undefined) {
    // YouTube analysis response  
    return {
      classification: parsed.classification === 'productive' ? 'productive' : 'unproductive',
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0))
    };
  } else {
    throw new Error('Invalid response format');
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Domain Classification
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    
    // Validation and sanitization
    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'Valid domain string required' });
    }
    
    const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!cleanDomain || cleanDomain.length > 253) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }
    
    const prompt = DOMAIN_CLASSIFICATION_PROMPT.replace('DOMAIN_PLACEHOLDER', cleanDomain);
    const response = await model.generateContent({ 
      contents: [{ role: 'user', parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 100
      }
    });
    
    const result = parseResponse(response.response.text());
    res.json(result);
    
  } catch (error) {
    console.error('Domain classification error:', error);
    res.status(500).json({ error: 'Classification failed' });
  }
});

// YouTube Analysis
app.post('/api/analyze-youtube', async (req, res) => {
  try {
    const { title, channelName } = req.body;
    
    // Validation
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Valid title string required' });
    }
    
    const cleanTitle = title.trim().substring(0, 500);
    const cleanChannel = (channelName || 'Unknown').trim().substring(0, 100);
    
    const prompt = YOUTUBE_ANALYSIS_PROMPT
      .replace('TITLE_PLACEHOLDER', cleanTitle)
      .replace('CHANNEL_PLACEHOLDER', cleanChannel);
    
    const response = await model.generateContent({ 
      contents: [{ role: 'user', parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 150
      }
    });
    
    const result = parseResponse(response.response.text());
    
    res.json({
      isProductive: result.classification === 'productive',
      score: result.score || 0,
      categories: [result.classification || 'unproductive'],
      explanation: `AI analysis: ${result.classification || 'unproductive'}`
    });
    
  } catch (error) {
    console.error('YouTube analysis error:', error);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
