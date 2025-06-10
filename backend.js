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

// PROMPT 1: Domain Classification
const DOMAIN_CLASSIFICATION_PROMPT = `
Analyze this domain: "${DOMAIN}"

RETURN JSON ONLY:
{
  "classification": "always_productive" | "always_unproductive"
}

RULES:
"always_productive": .edu, GitHub, Gmail, Slack, documentation, work tools
"always_unproductive": Netflix, social media, gaming, entertainment, shopping
`;

// PROMPT 2: YouTube Analysis  
const YOUTUBE_ANALYSIS_PROMPT = `
Title: "${TITLE}"
Channel: "${CHANNEL}"

RETURN JSON ONLY:
{
  "classification": "productive" | "unproductive",
  "score": number
}

STRICT RULES:
"productive" (70-100): Programming tutorials, academic lectures, technical training
"unproductive" (0-40): Everything else - sports, entertainment, lifestyle, news
When in doubt: unproductive
`;

function parseResponse(text) {
  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  }
  return JSON.parse(text);
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Domain Classification
app.post('/api/classify-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain required' });
    
    const prompt = DOMAIN_CLASSIFICATION_PROMPT.replace('${DOMAIN}', domain);
    const response = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }]}]});
    const result = parseResponse(response.response.text());
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Classification failed' });
  }
});

// YouTube Analysis
app.post('/api/analyze-youtube', async (req, res) => {
  try {
    const { title, channelName } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    
    const prompt = YOUTUBE_ANALYSIS_PROMPT
      .replace('${TITLE}', title || 'Unknown')
      .replace('${CHANNEL}', channelName || 'Unknown');
    
    const response = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }]}]});
    const result = parseResponse(response.response.text());
    
    res.json({
      isProductive: result.classification === 'productive',
      score: result.score || 0,
      categories: [result.classification],
      explanation: `AI analysis: ${result.classification}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Analysis failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
