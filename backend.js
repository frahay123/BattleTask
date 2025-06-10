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
Analyze this domain: "{DOMAIN}"

RETURN JSON ONLY:
{
  "classification": "always_productive" | "always_unproductive"
}

CLASSIFICATION CRITERIA:
ALWAYS_PRODUCTIVE domains (work/education/development):Add commentMore actions
- Educational:
- Development:
- Documentation: 
- Work Communication:
- Email/Calendar:
- Cloud Storage: 
- Design Tools: 
- Analytics/Admin
- Learning Platforms: 
- References: 

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
`;

// PROMPT 2: YouTube Analysis  
const YOUTUBE_ANALYSIS_PROMPT = `
Title: "{TITLE}"
Channel: "{CHANNEL}"

RETURN JSON ONLY:
{
  "classification": "productive" | "unproductive",
  "score": number
}

STRICT RULES:
PRODUCTIVITY SCORING:Add commentMore actions

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
