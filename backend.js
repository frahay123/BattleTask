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

// Backend API for BattleTask (ProductiveTime)
// This simulates a backend service for the extension

// Configuration
const CONFIG = {
  // API keys would normally be here
  PRODUCTIVITY_THRESHOLD: 60, // Score threshold for productive vs non-productive
  DOMAIN_CACHE_TIME: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  URL_CACHE_TIME: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
};

// In-memory cache for domain categorizations
const domainCache = {};

// In-memory cache for URL analyses
const urlCache = {};

// Domain categories
const DOMAIN_CATEGORIES = {
  'github.com': 'always-productive',
  'gitlab.com': 'always-productive',
  'stackoverflow.com': 'always-productive',
  'docs.google.com': 'always-productive',
  'drive.google.com': 'always-productive',
  'sheets.google.com': 'always-productive',
  'calendar.google.com': 'always-productive',
  'linkedin.com': 'always-productive',
  'coursera.org': 'always-productive',
  'udemy.com': 'always-productive',
  'edx.org': 'always-productive',
  'khanacademy.org': 'always-productive',
  'wikipedia.org': 'always-productive',
  'medium.com': 'context-dependent',
  'youtube.com': 'context-dependent',
  'facebook.com': 'always-nonproductive',
  'instagram.com': 'always-nonproductive',
  'twitter.com': 'always-nonproductive',
  'tiktok.com': 'always-nonproductive',
  'reddit.com': 'context-dependent',
  'netflix.com': 'always-nonproductive',
  'hulu.com': 'always-nonproductive',
  'amazon.com': 'context-dependent',
  'ebay.com': 'always-nonproductive',
  'twitch.tv': 'always-nonproductive'
};

// Context rules for context-dependent domains
const CONTEXT_RULES = {
  'youtube.com': [
    { pattern: 'https://www.youtube.com/watch?v=*&list=PL*', isProductive: true, explanation: 'Educational playlist' },
    { pattern: 'https://www.youtube.com/playlist?list=PL*', isProductive: true, explanation: 'Educational playlist' },
    { pattern: 'https://www.youtube.com/c/*tutorials*', isProductive: true, explanation: 'Tutorial channel' },
    { pattern: 'https://www.youtube.com/c/*education*', isProductive: true, explanation: 'Educational channel' },
    { pattern: 'https://www.youtube.com/c/*learn*', isProductive: true, explanation: 'Educational channel' }
  ],
  'reddit.com': [
    { pattern: 'https://www.reddit.com/r/programming*', isProductive: true, explanation: 'Programming subreddit' },
    { pattern: 'https://www.reddit.com/r/learnprogramming*', isProductive: true, explanation: 'Programming learning subreddit' },
    { pattern: 'https://www.reddit.com/r/cscareerquestions*', isProductive: true, explanation: 'Career development subreddit' },
    { pattern: 'https://www.reddit.com/r/science*', isProductive: true, explanation: 'Science subreddit' }
  ],
  'medium.com': [
    { pattern: 'https://medium.com/topic/programming*', isProductive: true, explanation: 'Programming articles' },
    { pattern: 'https://medium.com/topic/technology*', isProductive: true, explanation: 'Technology articles' },
    { pattern: 'https://medium.com/topic/data-science*', isProductive: true, explanation: 'Data science articles' }
  ],
  'amazon.com': [
    { pattern: 'https://www.amazon.com/books*', isProductive: true, explanation: 'Book shopping' },
    { pattern: 'https://www.amazon.com/*/books*', isProductive: true, explanation: 'Book shopping' },
    { pattern: 'https://www.amazon.com/*/educational*', isProductive: true, explanation: 'Educational materials' }
  ]
};

// Productive keywords for content analysis
const PRODUCTIVE_KEYWORDS = [
  'learn', 'tutorial', 'education', 'course', 'programming',
  'development', 'science', 'research', 'study', 'academic',
  'professional', 'career', 'job', 'work', 'project',
  'productivity', 'skill', 'knowledge', 'university', 'college'
];

// Non-productive keywords for content analysis
const NONPRODUCTIVE_KEYWORDS = [
  'game', 'play', 'entertainment', 'funny', 'meme',
  'viral', 'celebrity', 'gossip', 'trending', 'shopping',
  'sale', 'discount', 'deal', 'stream', 'watch',
  'movie', 'series', 'episode', 'season', 'trailer'
];

/**
 * Handle domain categorization request
 * @param {Object} request - The request object with domain
 * @returns {Object} - Response with categorization
 */
function handleDomainCategorization(request) {
  try {
    const domain = request.domain.toLowerCase();
    
    // Check cache first
    if (domainCache[domain] && domainCache[domain].timestamp > Date.now() - CONFIG.DOMAIN_CACHE_TIME) {
      return {
        success: true,
        categorization: domainCache[domain].data
      };
    }
    
    // Check predefined categories
    if (DOMAIN_CATEGORIES[domain]) {
      const category = DOMAIN_CATEGORIES[domain];
      let urlPatterns = [];
      
      // Include URL patterns for context-dependent domains
      if (category === 'context-dependent' && CONTEXT_RULES[domain]) {
        urlPatterns = CONTEXT_RULES[domain].map(rule => ({
          pattern: rule.pattern,
          isProductive: rule.isProductive
        }));
      }
      
      const result = {
        domain: domain,
        category: category,
        confidence: 0.95,
        urlPatterns: urlPatterns
      };
      
      // Cache the result
      domainCache[domain] = {
        timestamp: Date.now(),
        data: result
      };
      
      return {
        success: true,
        categorization: result
      };
    }
    
    // For domains not in our predefined list, analyze the domain name
    const domainParts = domain.split('.');
    const domainName = domainParts[0];
    
    // Analyze domain name for productivity indicators
    let category = 'context-dependent';
    let confidence = 0.6;
    
    // Check for educational domains
    if (domain.endsWith('.edu') || domain.endsWith('.ac.uk') || domain.endsWith('.edu.au')) {
      category = 'always-productive';
      confidence = 0.9;
    }
    // Check for known productive domain patterns
    else if (domainName.includes('learn') || domainName.includes('edu') || 
             domainName.includes('course') || domainName.includes('study') ||
             domainName.includes('academic') || domainName.includes('research') ||
             domainName.includes('science') || domainName.includes('dev')) {
      category = 'always-productive';
      confidence = 0.8;
    }
    // Check for known non-productive domain patterns
    else if (domainName.includes('game') || domainName.includes('play') || 
             domainName.includes('fun') || domainName.includes('entertainment') ||
             domainName.includes('meme') || domainName.includes('shop') ||
             domainName.includes('store') || domainName.includes('buy')) {
      category = 'always-nonproductive';
      confidence = 0.8;
    }
    
    const result = {
      domain: domain,
      category: category,
      confidence: confidence
    };
    
    // Cache the result
    domainCache[domain] = {
      timestamp: Date.now(),
      data: result
    };
    
    return {
      success: true,
      categorization: result
    };
    
  } catch (error) {
    console.error('Error in handleDomainCategorization:', error);
    return {
      success: false,
      error: 'Failed to categorize domain'
    };
  }
}

/**
 * Handle URL content analysis request
 * @param {Object} request - The request with URL, title, and content
 * @returns {Object} - Response with analysis
 */
function handleContentAnalysis(request) {
  try {
    const url = request.url;
    const title = request.title || '';
    const content = request.content || '';
    const domain = extractDomain(url);
    
    // Check cache first
    if (urlCache[url] && urlCache[url].timestamp > Date.now() - CONFIG.URL_CACHE_TIME) {
      return {
        success: true,
        analysis: urlCache[url].data
      };
    }
    
    // Get domain categorization first
    const domainCategorization = DOMAIN_CATEGORIES[domain];
    
    // If domain is always productive or non-productive, use that
    if (domainCategorization === 'always-productive') {
      const result = {
        isProductive: true,
        score: 100,
        categories: ['Work Tool'],
        explanation: 'Domain is categorized as always productive',
        domainCategory: 'always-productive'
      };
      
      // Cache the result
      urlCache[url] = {
        timestamp: Date.now(),
        data: result
      };
      
      return {
        success: true,
        analysis: result
      };
    }
    
    if (domainCategorization === 'always-nonproductive') {
      const result = {
        isProductive: false,
        score: 0,
        categories: ['Entertainment'],
        explanation: 'Domain is categorized as always non-productive',
        domainCategory: 'always-nonproductive'
      };
      
      // Cache the result
      urlCache[url] = {
        timestamp: Date.now(),
        data: result
      };
      
      return {
        success: true,
        analysis: result
      };
    }
    
    // For context-dependent domains, check URL patterns
    if (domainCategorization === 'context-dependent' && CONTEXT_RULES[domain]) {
      for (const rule of CONTEXT_RULES[domain]) {
        // Convert wildcard pattern to regex
        const pattern = rule.pattern.replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        
        if (regex.test(url)) {
          const result = {
            isProductive: rule.isProductive,
            score: rule.isProductive ? 100 : 0,
            categories: rule.isProductive ? ['Work'] : ['Entertainment'],
            explanation: rule.explanation || (rule.isProductive ? 'URL matches productive pattern' : 'URL matches non-productive pattern'),
            domainCategory: 'context-dependent',
            matchedPattern: rule.pattern
          };
          
          // Cache the result
          urlCache[url] = {
            timestamp: Date.now(),
            data: result
          };
          
          return {
            success: true,
            analysis: result
          };
        }
      }
    }
    
    // Analyze content if no pattern match
    // Combine title and content for analysis
    const combinedText = (title + ' ' + content).toLowerCase();
    
    // Count productive and non-productive keywords
    let productiveScore = 0;
    let nonProductiveScore = 0;
    
    PRODUCTIVE_KEYWORDS.forEach(keyword => {
      if (combinedText.includes(keyword)) {
        productiveScore += 1;
      }
    });
    
    NONPRODUCTIVE_KEYWORDS.forEach(keyword => {
      if (combinedText.includes(keyword)) {
        nonProductiveScore += 1;
      }
    });
    
    // Calculate normalized score (0-100)
    const totalKeywords = PRODUCTIVE_KEYWORDS.length + NONPRODUCTIVE_KEYWORDS.length;
    const normalizedScore = Math.min(100, Math.max(0, 
      50 + ((productiveScore / PRODUCTIVE_KEYWORDS.length) - (nonProductiveScore / NONPRODUCTIVE_KEYWORDS.length)) * 50
    ));
    
    // Determine categories
    const categories = [];
    if (normalizedScore >= CONFIG.PRODUCTIVITY_THRESHOLD) {
      if (combinedText.includes('programming') || combinedText.includes('coding')) {
        categories.push('Programming');
      }
      if (combinedText.includes('learn') || combinedText.includes('education')) {
        categories.push('Learning');
      }
      if (combinedText.includes('work') || combinedText.includes('job')) {
        categories.push('Work');
      }
      if (categories.length === 0) {
        categories.push('Productive');
      }
    } else {
      if (combinedText.includes('game') || combinedText.includes('play')) {
        categories.push('Gaming');
      }
      if (combinedText.includes('video') || combinedText.includes('watch')) {
        categories.push('Video');
      }
      if (combinedText.includes('shop') || combinedText.includes('buy')) {
        categories.push('Shopping');
      }
      if (categories.length === 0) {
        categories.push('Entertainment');
      }
    }
    
    // Generate explanation
    let explanation = '';
    if (normalizedScore >= CONFIG.PRODUCTIVITY_THRESHOLD) {
      explanation = `Content analysis indicates productive content (score: ${Math.round(normalizedScore)}). `;
      if (productiveScore > 0) {
        explanation += `Found ${productiveScore} productivity indicators.`;
      }
    } else {
      explanation = `Content analysis indicates non-productive content (score: ${Math.round(normalizedScore)}). `;
      if (nonProductiveScore > 0) {
        explanation += `Found ${nonProductiveScore} entertainment indicators.`;
      }
    }
    
    const result = {
      isProductive: normalizedScore >= CONFIG.PRODUCTIVITY_THRESHOLD,
      score: Math.round(normalizedScore),
      categories: categories,
      explanation: explanation,
      domainCategory: domainCategorization || 'unknown'
    };
    
    // Cache the result
    urlCache[url] = {
      timestamp: Date.now(),
      data: result
    };
    
    return {
      success: true,
      analysis: result
    };
    
  } catch (error) {
    console.error('Error in handleContentAnalysis:', error);
    return {
      success: false,
      error: 'Failed to analyze content'
    };
  }
}

/**
 * Handle title-only analysis request
 * @param {Object} request - The request with URL and title
 * @returns {Object} - Response with analysis
 */
function handleTitleAnalysis(request) {
  try {
    const url = request.url;
    const title = request.title || '';
    const domain = request.domain || extractDomain(url);
    
    // Check cache first
    if (urlCache[url] && urlCache[url].timestamp > Date.now() - CONFIG.URL_CACHE_TIME) {
      return {
        success: true,
        analysis: urlCache[url].data
      };
    }
    
    // Get domain categorization first
    const domainCategorization = DOMAIN_CATEGORIES[domain];
    
    // If domain is always productive or non-productive, use that
    if (domainCategorization === 'always-productive') {
      const result = {
        isProductive: true,
        score: 100,
        categories: ['Work Tool'],
        explanation: 'Domain is categorized as always productive',
        domainCategory: 'always-productive'
      };
      
      // Cache the result
      urlCache[url] = {
        timestamp: Date.now(),
        data: result
      };
      
      return {
        success: true,
        analysis: result
      };
    }
    
    if (domainCategorization === 'always-nonproductive') {
      const result = {
        isProductive: false,
        score: 0,
        categories: ['Entertainment'],
        explanation: 'Domain is categorized as always non-productive',
        domainCategory: 'always-nonproductive'
      };
      
      // Cache the result
      urlCache[url] = {
        timestamp: Date.now(),
        data: result
      };
      
      return {
        success: true,
        analysis: result
      };
    }
    
    // For context-dependent domains, check URL patterns
    if (domainCategorization === 'context-dependent' && CONTEXT_RULES[domain]) {
      for (const rule of CONTEXT_RULES[domain]) {
        // Convert wildcard pattern to regex
        const pattern = rule.pattern.replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        
        if (regex.test(url)) {
          const result = {
            isProductive: rule.isProductive,
            score: rule.isProductive ? 100 : 0,
            categories: rule.isProductive ? ['Work'] : ['Entertainment'],
            explanation: rule.explanation || (rule.isProductive ? 'URL matches productive pattern' : 'URL matches non-productive pattern'),
            domainCategory: 'context-dependent',
            matchedPattern: rule.pattern
          };
          
          // Cache the result
          urlCache[url] = {
            timestamp: Date.now(),
            data: result
          };
          
          return {
            success: true,
            analysis: result
          };
        }
      }
    }
    
    // Analyze title if no pattern match
    const titleLower = title.toLowerCase();
    
    // Count productive and non-productive keywords
    let productiveScore = 0;
    let nonProductiveScore = 0;
    
    PRODUCTIVE_KEYWORDS.forEach(keyword => {
      if (titleLower.includes(keyword)) {
        productiveScore += 1;
      }
    });
    
    NONPRODUCTIVE_KEYWORDS.forEach(keyword => {
      if (titleLower.includes(keyword)) {
        nonProductiveScore += 1;
      }
    });
    
    // Calculate normalized score (0-100)
    let normalizedScore = 50; // Default to neutral
    
    if (productiveScore > 0 || nonProductiveScore > 0) {
      normalizedScore = Math.min(100, Math.max(0, 
        50 + ((productiveScore / PRODUCTIVE_KEYWORDS.length) - (nonProductiveScore / NONPRODUCTIVE_KEYWORDS.length)) * 50
      ));
    }
    
    // Determine categories
    const categories = [];
    if (normalizedScore >= CONFIG.PRODUCTIVITY_THRESHOLD) {
      if (titleLower.includes('programming') || titleLower.includes('coding')) {
        categories.push('Programming');
      }
      if (titleLower.includes('learn') || titleLower.includes('education')) {
        categories.push('Learning');
      }
      if (titleLower.includes('work') || titleLower.includes('job')) {
        categories.push('Work');
      }
      if (categories.length === 0) {
        categories.push('Productive');
      }
    } else {
      if (titleLower.includes('game') || titleLower.includes('play')) {
        categories.push('Gaming');
      }
      if (titleLower.includes('video') || titleLower.includes('watch')) {
        categories.push('Video');
      }
      if (titleLower.includes('shop') || titleLower.includes('buy')) {
        categories.push('Shopping');
      }
      if (categories.length === 0) {
        categories.push('Entertainment');
      }
    }
    
    // Generate explanation
    let explanation = '';
    if (normalizedScore >= CONFIG.PRODUCTIVITY_THRESHOLD) {
      explanation = `Title analysis indicates productive content (score: ${Math.round(normalizedScore)}). `;
      if (productiveScore > 0) {
        explanation += `Found ${productiveScore} productivity indicators.`;
      }
    } else {
      explanation = `Title analysis indicates non-productive content (score: ${Math.round(normalizedScore)}). `;
      if (nonProductiveScore > 0) {
        explanation += `Found ${nonProductiveScore} entertainment indicators.`;
      }
    }
    
    const result = {
      isProductive: normalizedScore >= CONFIG.PRODUCTIVITY_THRESHOLD,
      score: Math.round(normalizedScore),
      categories: categories,
      explanation: explanation,
      domainCategory: domainCategorization || 'unknown'
    };
    
    // Cache the result
    urlCache[url] = {
      timestamp: Date.now(),
      data: result
    };
    
    return {
      success: true,
      analysis: result
    };
    
  } catch (error) {
    console.error('Error in handleTitleAnalysis:', error);
    return {
      success: false,
      error: 'Failed to analyze title'
    };
  }
}

/**
 * Extract domain from URL
 * @param {string} url - The URL
 * @returns {string} - The extracted domain
 */
function extractDomain(url) {
  try {
    if (!url) return '';
    
    // Remove protocol and get hostname
    let domain = url.replace(/^(https?:\/\/)?(www\.)?/, '');
    domain = domain.split('/')[0].split('?')[0];
    
    return domain;
  } catch (error) {
    console.error('Error extracting domain:', error);
    return '';
  }
}

// Export functions for use in extension
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    handleDomainCategorization,
    handleContentAnalysis,
    handleTitleAnalysis
  };
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
