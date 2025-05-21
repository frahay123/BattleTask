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

// API usage tracking
const apiUsageStats = {
  dailyCalls: 0,
  titleAnalysisCalls: 0,
  contentAnalysisCalls: 0,
  domainCategorizationCalls: 0,
  lastReset: new Date().toISOString().split('T')[0], // Today's date in YYYY-MM-DD format
  resetTime: '00:00:00', // Reset time in UTC
  errors: 0,
  tokensUsed: 0, // Estimated token usage
  // Keep daily history for the last 7 days
  history: []
};

// Check and reset API usage stats if needed
function checkAndResetApiStats() {
  const today = new Date().toISOString().split('T')[0];
  
  // If it's a new day, reset counters
  if (today !== apiUsageStats.lastReset) {
    // Save previous day to history (limit to 7 days)
    apiUsageStats.history.unshift({
      date: apiUsageStats.lastReset,
      dailyCalls: apiUsageStats.dailyCalls,
      titleAnalysisCalls: apiUsageStats.titleAnalysisCalls,
      contentAnalysisCalls: apiUsageStats.contentAnalysisCalls,
      domainCategorizationCalls: apiUsageStats.domainCategorizationCalls,
      errors: apiUsageStats.errors,
      tokensUsed: apiUsageStats.tokensUsed
    });
    
    // Keep only the last 7 days
    if (apiUsageStats.history.length > 7) {
      apiUsageStats.history = apiUsageStats.history.slice(0, 7);
    }
    
    // Reset counters
    apiUsageStats.dailyCalls = 0;
    apiUsageStats.titleAnalysisCalls = 0;
    apiUsageStats.contentAnalysisCalls = 0;
    apiUsageStats.domainCategorizationCalls = 0;
    apiUsageStats.errors = 0;
    apiUsageStats.tokensUsed = 0;
    apiUsageStats.lastReset = today;
    
    console.log(`API usage stats reset for new day: ${today}`);
  }
}

// Middleware to track API usage
function trackApiUsage(type) {
  return (req, res, next) => {
    // Check if stats should be reset
    checkAndResetApiStats();
    
    // Increment counters
    apiUsageStats.dailyCalls++;
    
    // Track specific type
    switch(type) {
      case 'title':
        apiUsageStats.titleAnalysisCalls++;
        // Rough estimate: 300 tokens for prompt + 50 for title
        apiUsageStats.tokensUsed += 350;
        break;
      case 'content':
        apiUsageStats.contentAnalysisCalls++;
        // Rough estimate: 350 tokens for prompt + 2000 for content
        apiUsageStats.tokensUsed += 2350;
        break;
      case 'domain':
        apiUsageStats.domainCategorizationCalls++;
        // Rough estimate: 250 tokens for prompt + 20 for domain
        apiUsageStats.tokensUsed += 270;
        break;
    }
    
    next();
  };
}

// Gemini API configuration
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Simple domain categorization cache to reduce API calls
const domainCategoryCache = new Map();
// Cache expiration time: 7 days (in milliseconds)
const CACHE_EXPIRATION = 7 * 24 * 60 * 60 * 1000;
// Cache expiration for error or forced context-dependent results: 1 day
const ERROR_CACHE_EXPIRATION = 24 * 60 * 60 * 1000;

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

// Clear any cached classification for potentially problematic domains
// This prevents incorrect classifications from persisting
console.log('Clearing frequently used mixed-content domains from cache on startup');
const domainsToReset = [
  // Most common problematic domains that should always be context-dependent
  'youtube.com', 'youtu.be', 'reddit.com', 'twitter.com', 'x.com', 
  'facebook.com', 'linkedin.com', 'instagram.com', 'tiktok.com',
  'amazon.com', 'netflix.com', 'google.com', 'github.com', 'stackoverflow.com',
  'wikipedia.org', 'medium.com', 'quora.com', 'spotify.com', 'ted.com',
  
  // Email clients that should be always productive
  'gmail.com', 'mail.google.com', 'outlook.com', 'outlook.office.com',
  'mail.yahoo.com', 'protonmail.com', 'mail.proton.me', 'fastmail.com',
  'hotmail.com', 'yahoo.com'
];

// Count how many domains were reset
let resetCount = 0;
domainsToReset.forEach(domain => {
  if (domainCategoryCache.has(domain)) {
    console.log(`Removing ${domain} from domain classification cache`);
    domainCategoryCache.delete(domain);
    resetCount++;
  }
});

console.log(`Reset ${resetCount} domains in cache at startup`);

// Clear the entire cache once per day if server stays running
// This helps ensure we don't keep stale classifications
setInterval(() => {
  const cacheSize = domainCategoryCache.size;
  if (cacheSize > 0) {
    console.log(`Clearing entire domain classification cache (${cacheSize} entries)`);
    domainCategoryCache.clear();
  }
}, 24 * 60 * 60 * 1000); // 24 hours

/**
 * Get domain categorization - either from cache or by calling the API
 * @param {string} domain - The domain to categorize
 * @returns {Object} Domain categorization
 */
async function getDomainCategory(domain) {
  if (!domain) {
    console.log('getDomainCategory called with empty domain');
    return {
      category: 'unknown',
      reason: 'No domain provided'
    };
  }
  
  // Check cache first
  if (domainCategoryCache.has(domain)) {
    const cachedResult = domainCategoryCache.get(domain);
    
    // Use different expiration times for different types of cached results
    const expirationTime = (cachedResult.forcedClassification || 
                          cachedResult.reason?.includes('Error during domain categorization')) 
                          ? ERROR_CACHE_EXPIRATION : CACHE_EXPIRATION;
    
    // If cache entry is still valid (not expired)
    if (Date.now() - cachedResult.timestamp < expirationTime) {
      console.log(`Domain ${domain} categorization found in cache: ${cachedResult.category}`);
      console.log(`Cache type: ${cachedResult.forcedClassification ? 'forced' : 
                 (cachedResult.reason?.includes('Error') ? 'error' : 'normal')}`);
      return cachedResult;
    } else {
      console.log(`Domain ${domain} found in cache but expired, will recategorize`);
      console.log(`Cache expired after ${Math.round((Date.now() - cachedResult.timestamp) / (1000 * 60 * 60))} hours`);
    }
  } else {
    console.log(`Domain ${domain} not in cache, will categorize via API`);
  }
  
  try {
    console.log(`Generating domain categorization for ${domain} using Gemini API`);
    
    // Create a compact prompt for domain categorization to minimize token usage
    // Check if this is a known mixed-content domain that should always be context-dependent
    // Helper function to check if a domain is always productive
    function isAlwaysProductiveDomain(domainToCheck) {
      // Direct match
      if (alwaysProductiveDomains.includes(domainToCheck)) {
        return true;
      }
      
      // Check for subdomains of always productive domains
      for (const prodDomain of alwaysProductiveDomains) {
        if (domainToCheck.endsWith(`.${prodDomain}`)) {
          return true;
        }
      }
      
      return false;
    }
    
    // These domains contain truly mixed content that needs to be analyzed per-page
    const knownMixedContentDomains = [
      // Video platforms with truly mixed content
      'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
      'nebula.tv', 'curiositystream.com', 'ted.com',
      
      // Social media and discussion platforms
      'reddit.com', 'twitter.com', 'x.com', 'facebook.com',
      'instagram.com', 'pinterest.com', 'tumblr.com', 'mastodon.social',
      'tiktok.com', 'discord.com', 'quora.com', 'medium.com', 'substack.com',
      'hackernews.com', 'news.ycombinator.com', 'discourse.org',
      
      // News and media
      'nytimes.com', 'wsj.com', 'washingtonpost.com', 'ft.com', 'economist.com',
      'cnn.com', 'foxnews.com', 'bbc.com', 'bbc.co.uk', 'reuters.com', 
      'apnews.com', 'bloomberg.com', 'cnbc.com', 'forbes.com', 'businessinsider.com',
      'theguardian.com', 'independent.co.uk', 'aljazeera.com', 'time.com',
      'newsweek.com', 'theatlantic.com', 'newyorker.com', 'wired.com',
      'techcrunch.com', 'arstechnica.com', 'engadget.com', 'theverge.com',
      'news.yahoo.com', 'news.google.com', 'msn.com', 'cnet.com', 'zdnet.com',
      
      // Content aggregators
      'flipboard.com', 'feedly.com', 'pocket.co', 'getpocket.com', 'instapaper.com',
      'digg.com', 'slashdot.org', 'metafilter.com', 'producthunt.com',
      
      // Wikipedia (depends on the article)
      'wikipedia.org',
      
      // Streaming and entertainment (could include educational content)
      'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'hbomax.com',
      'peacocktv.com', 'paramountplus.com', 'discoveryplus.com', 'appletv.apple.com',
      
      // E-commerce and marketplaces (could be productive or unproductive)
      'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
      'bestbuy.com', 'newegg.com', 'alibaba.com', 'aliexpress.com',
      'homedepot.com', 'lowes.com', 'ikea.com', 'wayfair.com',
      
      // General search and browsing
      'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com',
      
      // Audio platforms with mixed content
      'spotify.com', 'podcasts.apple.com', 'soundcloud.com', 'audible.com',
      'iheart.com', 'pandora.com', 'tunein.com', 'stitcher.com',
      
      // Creative and hobby platforms
      'behance.net', 'dribbble.com', 'deviantart.com', 'flickr.com',
      'unsplash.com', 'pexels.com', 'pixabay.com', 'instructables.com',
      'ravelry.com', 'allrecipes.com', 'epicurious.com', 'foodnetwork.com',
      
      // Other popular mixed-content sites
      'goodreads.com', 'imdb.com', 'rottentomatoes.com', 'metacritic.com',
      'webmd.com', 'mayoclinic.org', 'healthline.com', 'medlineplus.gov',
      'zillow.com', 'redfin.com', 'realtor.com', 'tripadvisor.com', 'expedia.com',
      'booking.com', 'airbnb.com', 'maps.google.com'
    ];
    
    // List of email clients that should always be marked as productive
    const emailDomains = [
      'gmail.com', 'mail.google.com', 'outlook.com', 'outlook.office.com', 'outlook.live.com',
      'mail.yahoo.com', 'yahoo.mail.com', 'mail.proton.me', 'protonmail.com', 'aol.com',
      'mail.aol.com', 'zoho.com', 'mail.zoho.com', 'icloud.com', 'mail.icloud.com',
      'mail.com', 'fastmail.com', 'mail.ru', 'yandex.mail.ru', 'tutanota.com',
      'hey.com', 'hotmail.com', 'live.com', 'mail.sina.com', 'mail.qq.com',
      'gmx.com', 'gmx.net', 'web.de', 'mail.163.com', 'mail.126.com',
      'mail.yandex.com', 'yandex.com'
    ];
    
    // Helper function to check if a domain is an email client
    function isEmailClient(domainToCheck) {
      // Direct match
      if (emailDomains.includes(domainToCheck)) {
        return true;
      }
      
      // Check for subdomains of email services
      for (const emailDomain of emailDomains) {
        if (domainToCheck.endsWith(`.${emailDomain}`)) {
          return true;
        }
      }
      
      // Check for common email client patterns
      if (domainToCheck.includes('mail.') || 
          domainToCheck.includes('email.') || 
          domainToCheck.includes('webmail.') || 
          domainToCheck.includes('outlook.') ||
          domainToCheck.match(/mail\d*\.[a-z]+\.[a-z]+$/)) {
        return true;
      }
      
      return false;
    }
    
    // Helper function to check if a domain matches any in our mixed-content list
    function isMixedContentDomain(domainToCheck) {
      // Direct match
      if (knownMixedContentDomains.includes(domainToCheck)) {
        return true;
      }
      
      // Check for subdomains (e.g., sub.example.com matches example.com)
      for (const knownDomain of knownMixedContentDomains) {
        if (domainToCheck.endsWith(`.${knownDomain}`)) {
          return true;
        }
        
        // Special case for country-specific domains (e.g., amazon.co.uk should match amazon.com)
        const baseDomain = knownDomain.split('.')[0];
        if (baseDomain.length > 3 && !baseDomain.includes('/') && 
            domainToCheck.includes(baseDomain) && 
            (domainToCheck.includes('.co.') || domainToCheck.includes('.com.') || 
             domainToCheck.match(/\.[a-z]{2}$/) !== null)) {
          return true;
        }
      }
      
      return false;
    }
    
    // Special case: Email clients are always productive
    if (isEmailClient(domain)) {
      console.log(`Domain ${domain} is an email client, forcing always-productive classification`);
      return {
        category: 'always-productive',
        reason: 'Email clients are considered work/productivity tools',
        timestamp: Date.now(),
        domain: domain
      };
    }
    
    // Special case: Educational/productivity domains are always productive
    if (isAlwaysProductiveDomain(domain)) {
      console.log(`Domain ${domain} is an educational/productivity tool, forcing always-productive classification`);
      return {
        category: 'always-productive',
        reason: 'Educational and productivity platforms are considered work tools',
        timestamp: Date.now(),
        domain: domain
      };
    }
    
    if (isMixedContentDomain(domain)) {
      console.log(`Domain ${domain} is a known mixed-content site, forcing context-dependent classification`);
      const forcedResult = {
        category: 'context-dependent',
        reason: 'This site contains both productive and non-productive content that varies by specific usage',
        timestamp: Date.now(),
        domain: domain,
        forcedClassification: true
      };
      
      // Cache with shorter expiration for forced classifications
      domainCategoryCache.set(domain, forcedResult);
      
      return forcedResult;
    }
    
    const prompt = `Categorize domain "${domain}" as one of: "always-productive" (work/education), "always-nonproductive" (entertainment/social), or "context-dependent" (varies by content). For video sites, news sites, or social media, ALWAYS use "context-dependent" as they can contain both educational and entertainment content. Use "context-dependent" whenever there's doubt.
Return only JSON:
{"category":"category_name","reason":"brief reason","urlPatterns":["pattern1","pattern2"]}
`;

    // Make request to Gemini API
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      jsonText = responseText.split('```')[1].split('```')[0].trim();
    }
    
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse JSON response from AI model');
    }
    
    const analysis = JSON.parse(jsonMatch[0]);
    
    // Validate the response
    if (!analysis.category || !['always-productive', 'always-nonproductive', 'context-dependent'].includes(analysis.category)) {
      throw new Error('Invalid category in AI response');
    }
    
    // Add timestamp and domain for reference
    analysis.timestamp = Date.now();
    analysis.domain = domain;
    
    // Store in cache
    domainCategoryCache.set(domain, analysis);
    
    console.log(`Successfully categorized domain ${domain} as ${analysis.category} and cached result`);
    return analysis;
  } catch (error) {
    console.error('Error getting domain category:', error);
    // Increment error counter
    apiUsageStats.errors++;
    
    // For error cases, we want to be more cautious about classification
    // Check if this domain is likely to be a mixed content domain based on keywords
    const domainLower = domain.toLowerCase();
    const likelyMixedContent = 
      domainLower.includes('tube') || 
      domainLower.includes('video') || 
      domainLower.includes('news') || 
      domainLower.includes('social') || 
      domainLower.includes('media') || 
      domainLower.includes('edu') || 
      domainLower.includes('learn') || 
      domainLower.includes('forum') || 
      domainLower.includes('community') || 
      domainLower.includes('watch');
    
    // Return a default value for error cases - always use context-dependent when in doubt
    const defaultResult = {
      category: 'context-dependent',
      reason: `Error during domain categorization: ${error.message}. Using context-dependent to allow content-specific analysis.`,
      timestamp: Date.now(),
      domain: domain
    };
    
    // Cache error result with a shorter expiration (1 day) to force retry sooner
    domainCategoryCache.set(domain, defaultResult);
    console.log(`Error categorizing domain ${domain}, using default context-dependent and caching to prevent repeated errors. Likely mixed content: ${likelyMixedContent}`);
    
    return defaultResult;
  }
}

/**
 * Unified analysis function that prioritizes domain categorization
 * @param {string} title - The title of the page
 * @param {string} url - The URL of the page
 * @param {string} domain - The domain of the page
 * @param {string|null} content - The content to analyze (optional)
 * @returns {Object} Analysis result
 */
async function analyzeTab(title, url, domain, content = null) {
  // Handle empty or new tabs
  if (!title || title.trim() === '' || title === 'New Tab') {
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Empty or new tab',
      domainCategory: 'unknown',
      domainReason: 'Empty or new tab',
      domain: domain
    };
  }

  try {
    console.log(`Analyzing tab: domain=${domain}, url=${url}, title=${title}`);
    
    // List of domains that should always be classified as productive
    const alwaysProductiveDomains = [
      // Educational platforms
      'coursera.org', 'udemy.com', 'khanacademy.org', 'edx.org', 'pluralsight.com',
      'lynda.com', 'linkedin.com/learning', 'brilliant.org', 'wondrium.com',
      'masterclass.com', 'skillshare.com', 'codecademy.com', 'freecodecamp.org',
      'futurelearn.com', 'datacamp.com', 'sololearn.com', 'duolingo.com',
      'memrise.com', 'rosettastone.com', 'babbel.com', 'learncodeonline.in',
      
      // Research and academic
      'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov', 'jstor.org',
      'researchgate.net', 'academia.edu', 'arxiv.org', 'semanticscholar.org',
      'sciencedirect.com', 'nature.com', 'science.org', 'ieee.org', 'acm.org',
      
      // Productivity and work tools
      'docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com',
      'calendar.google.com', 'meet.google.com', 'office.com', 'office365.com',
      'microsoft365.com', 'teams.microsoft.com', 'sharepoint.com', 'onedrive.live.com',
      'notion.so', 'evernote.com', 'trello.com', 'asana.com', 'monday.com',
      'airtable.com', 'figma.com', 'miro.com', 'atlassian.com', 'jira.com',
      'confluence.com', 'zoom.us', 'webex.com', 'slack.com', 'dropbox.com',
      'box.com', 'miro.com', 'lucidchart.com', 'smartsheet.com', 'clickup.com',
      
      // Development and technical
      'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com',
      'replit.com', 'codesandbox.io', 'codepen.io', 'jsfiddle.net', 'aws.amazon.com',
      'cloud.google.com', 'azure.microsoft.com', 'digitalocean.com', 'heroku.com',
      'vercel.com', 'netlify.com', 'firebase.google.com'
    ];

    // Check if this is a known mixed-content domain that should always skip domain categorization
    const knownMixedContentDomains = [
      // Video platforms with mixed content
      'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
      'nebula.tv', 'curiositystream.com', 'ted.com',
      
      // Social media and discussion platforms
      'reddit.com', 'twitter.com', 'x.com', 'linkedin.com', 'facebook.com',
      'instagram.com', 'pinterest.com', 'tumblr.com', 'mastodon.social',
      'tiktok.com', 'discordapp.com', 'discord.com', 'slack.com', 'teams.microsoft.com',
      'quora.com', 'stackoverflow.com', 'stackexchange.com', 'medium.com', 'substack.com',
      'hackernews.com', 'news.ycombinator.com', 'discourse.org', 'github.com',
      
      // News and media
      'nytimes.com', 'wsj.com', 'washingtonpost.com', 'ft.com', 'economist.com',
      'cnn.com', 'foxnews.com', 'bbc.com', 'bbc.co.uk', 'reuters.com', 
      'apnews.com', 'bloomberg.com', 'cnbc.com', 'forbes.com', 'businessinsider.com',
      'theguardian.com', 'independent.co.uk', 'aljazeera.com', 'time.com',
      'newsweek.com', 'theatlantic.com', 'newyorker.com', 'wired.com',
      'techcrunch.com', 'arstechnica.com', 'engadget.com', 'theverge.com',
      'news.yahoo.com', 'news.google.com', 'msn.com', 'cnet.com', 'zdnet.com',
      
      // Content aggregators
      'flipboard.com', 'feedly.com', 'pocket.co', 'getpocket.com', 'instapaper.com',
      'digg.com', 'slashdot.org', 'metafilter.com', 'producthunt.com',
      
      // Research and reference
      'wikipedia.org', 'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov', 'jstor.org',
      'researchgate.net', 'academia.edu', 'arxiv.org', 'semanticscholar.org',
      
      // Streaming and entertainment (could include educational content)
      'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'hbomax.com',
      'peacocktv.com', 'paramountplus.com', 'discoveryplus.com', 'appletv.apple.com',
      
      // E-commerce and marketplaces (could be productive or unproductive)
      'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
      'bestbuy.com', 'newegg.com', 'alibaba.com', 'aliexpress.com',
      'homedepot.com', 'lowes.com', 'ikea.com', 'wayfair.com',
      
      // Productivity and work tools with mixed usage
      'google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com',
      'office.com', 'microsoft.com', 'notion.so', 'evernote.com', 'trello.com',
      'asana.com', 'monday.com', 'airtable.com', 'figma.com', 'miro.com',
      
      // Audio platforms with mixed content
      'spotify.com', 'podcasts.apple.com', 'soundcloud.com', 'audible.com',
      'iheart.com', 'pandora.com', 'tunein.com', 'stitcher.com',
      
      // Creative and hobby platforms
      'behance.net', 'dribbble.com', 'deviantart.com', 'flickr.com',
      'unsplash.com', 'pexels.com', 'pixabay.com', 'instructables.com',
      'ravelry.com', 'allrecipes.com', 'epicurious.com', 'foodnetwork.com',
      
      // Other popular mixed-content sites
      'goodreads.com', 'imdb.com', 'rottentomatoes.com', 'metacritic.com',
      'webmd.com', 'mayoclinic.org', 'healthline.com', 'medlineplus.gov',
      'zillow.com', 'redfin.com', 'realtor.com', 'tripadvisor.com', 'expedia.com',
      'booking.com', 'airbnb.com', 'maps.google.com'
    ];
    
    // List of email clients that should always be marked as productive
    const emailDomains = [
      'gmail.com', 'mail.google.com', 'outlook.com', 'outlook.office.com', 'outlook.live.com',
      'mail.yahoo.com', 'yahoo.mail.com', 'mail.proton.me', 'protonmail.com', 'aol.com',
      'mail.aol.com', 'zoho.com', 'mail.zoho.com', 'icloud.com', 'mail.icloud.com',
      'mail.com', 'fastmail.com', 'mail.ru', 'yandex.mail.ru', 'tutanota.com',
      'hey.com', 'hotmail.com', 'live.com', 'mail.sina.com', 'mail.qq.com',
      'gmx.com', 'gmx.net', 'web.de', 'mail.163.com', 'mail.126.com',
      'mail.yandex.com', 'yandex.com'
    ];
    
    // Helper function to check if a domain is an email client
    function isEmailClient(domainToCheck) {
      // Direct match
      if (emailDomains.includes(domainToCheck)) {
        return true;
      }
      
      // Check for subdomains of email services
      for (const emailDomain of emailDomains) {
        if (domainToCheck.endsWith(`.${emailDomain}`)) {
          return true;
        }
      }
      
      // Check for common email client patterns
      if (domainToCheck.includes('mail.') || 
          domainToCheck.includes('email.') || 
          domainToCheck.includes('webmail.') || 
          domainToCheck.includes('outlook.') ||
          domainToCheck.match(/mail\d*\.[a-z]+\.[a-z]+$/)) {
        return true;
      }
      
      return false;
    }
    
    // Helper function to check if a domain matches any in our mixed-content list
    function isMixedContentDomain(domainToCheck) {
      // Direct match
      if (knownMixedContentDomains.includes(domainToCheck)) {
        return true;
      }
      
      // Check for subdomains (e.g., sub.example.com matches example.com)
      for (const knownDomain of knownMixedContentDomains) {
        if (domainToCheck.endsWith(`.${knownDomain}`)) {
          return true;
        }
        
        // Special case for country-specific domains (e.g., amazon.co.uk should match amazon.com)
        const baseDomain = knownDomain.split('.')[0];
        if (baseDomain.length > 3 && !baseDomain.includes('/') && 
            domainToCheck.includes(baseDomain) && 
            (domainToCheck.includes('.co.') || domainToCheck.includes('.com.') || 
             domainToCheck.match(/\.[a-z]{2}$/) !== null)) {
          return true;
        }
      }
      
      return false;
    }
    
    // Special case: Email clients are always productive regardless of content
    if (isEmailClient(domain)) {
      console.log(`Domain ${domain} is an email client, automatically marking as productive`);
      return {
        isProductive: true,
        score: 95,
        categories: ['Work', 'Communication'],
        explanation: 'Email clients are automatically marked as productive',
        domainCategory: 'always-productive',
        domainReason: 'Email clients are considered work tools',
        domain: domain,
        analysisSource: 'email-client-rule',
        skipContentAnalysis: true
      };
    }
    
    // For known mixed-content domains, skip domain categorization completely and go straight to content/title analysis
    if (isMixedContentDomain(domain)) {
      console.log(`Domain ${domain} is a known mixed-content site, skipping domain categorization and going directly to content analysis`);
      
      // Create a fake domain info object for context-dependent domains
      const mixedContentDomainInfo = {
        category: 'context-dependent',
        reason: 'This site contains both productive and non-productive content that varies by specific usage',
        domain: domain,
        knownMixedContent: true, // Add this flag to indicate this is a known mixed-content domain
        skipDomainCheck: true    // Indicate we're skipping domain checks for this site
      };
      
      // Go directly to content or title analysis based on what's available
      if (content && content.trim() !== '') {
        // Extra logging for YouTube analysis
        if (domain === 'youtube.com' || domain === 'youtu.be') {
          console.log(`YouTube content analysis for: ${title}`);
          console.log(`Content snippet: ${content.substring(0, 100)}...`);
        }
        return await analyzeContentWithDomainInfo(title, content, url, domain, mixedContentDomainInfo);
      } else {
        // Extra logging for YouTube analysis
        if (domain === 'youtube.com' || domain === 'youtu.be') {
          console.log(`YouTube title-only analysis for: ${title}`);
        }
        return await analyzeTitleWithDomainInfo(title, url, domain, mixedContentDomainInfo);
      }
    }
    
    // STEP 1: For non-mixed content domains, get domain categorization first
    console.log(`Getting domain categorization for ${domain}`);
    const domainCategorization = await getDomainCategory(domain);
    console.log(`Domain ${domain} categorized as: ${domainCategorization.category}`);
    
    // STEP 2: If domain is definitively categorized, return immediately without content analysis
    if (domainCategorization.category === 'always-productive') {
      console.log(`Domain ${domain} is always-productive, skipping content analysis`);
      return {
        isProductive: true,
        score: 90,
        categories: [],
        explanation: `Domain ${domain} is categorized as always productive: ${domainCategorization.reason}`,
        domainCategory: 'always-productive',
        domainReason: domainCategorization.reason,
        domain: domain,
        analysisSource: 'domain-categorization' // Track the source for analytics
      };
    } else if (domainCategorization.category === 'always-nonproductive') {
      console.log(`Domain ${domain} is always-nonproductive, skipping content analysis`);
      return {
        isProductive: false,
        score: 10,
        categories: [],
        explanation: `Domain ${domain} is categorized as always non-productive: ${domainCategorization.reason}`,
        domainCategory: 'always-nonproductive',
        domainReason: domainCategorization.reason,
        domain: domain,
        analysisSource: 'domain-categorization' // Track the source for analytics
      };
    }
    
    // STEP 3: Only for context-dependent domains, analyze content
    console.log(`Domain ${domain} is context-dependent, proceeding with ${content ? 'content' : 'title'} analysis`);
    
    // For context-dependent domains, analyze content if available, otherwise analyze title
    if (content && content.trim() !== '') {
      return await analyzeContentWithDomainInfo(title, content, url, domain, domainCategorization);
    } else {
      return await analyzeTitleWithDomainInfo(title, url, domain, domainCategorization);
    }
  } catch (error) {
    console.error('Error in unified analysis:', error);
    
    // Increment error counter
    apiUsageStats.errors++;
    
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error during analysis',
      domainCategory: 'context-dependent',
      domainReason: 'Unable to categorize due to analysis error',
      domain: domain,
      analysisSource: 'error' // Track the source for analytics
    };
  }
}

/**
 * Analyze a tab title with pre-existing domain information
 */
async function analyzeTitleWithDomainInfo(title, url, domain, domainInfo) {
  try {
    console.log(`Analyzing title for context-dependent domain ${domain}: "${title}"`);
    
    // Check if this is a known mixed content domain (YouTube, Reddit, etc.)
    const isKnownMixedContent = domainInfo.knownMixedContent || 
                              (domain === 'youtube.com' || domain === 'youtu.be' || 
                               domain === 'reddit.com' || domain === 'twitter.com' || 
                               domain === 'x.com');
    
    // Special handling for YouTube to improve analysis
    let enhancedPrompt = '';
    if (domain === 'youtube.com' || domain === 'youtu.be') {
      enhancedPrompt = `When analyzing YouTube content:
- Educational videos, tutorials, lectures, documentaries are productive
- Entertainment, gaming, music videos, comedy are non-productive
- Learning content in entertaining format (like educational channels) should be productive
- Analyze title carefully to determine if it's educational or entertainment
`;
    }
    
    // Special handling for other domains with mixed content types
    if (domain === 'reddit.com') {
      enhancedPrompt = `For Reddit, consider the subreddit and topic:
- Educational, science, learning, career subreddits are productive
- Entertainment, memes, gaming subreddits are non-productive
`;
    }
    
    // Create compact title analysis prompt to minimize token usage
    const prompt = `Classify: "${title}" (URL: ${url})
Domain ${domain} is "${domainInfo.category}": "${domainInfo.reason}"
${enhancedPrompt}Return only JSON: {"isProductive":true/false,"score":0-100,"categories":[],"explanation":"reason"}
Productive = educational/work/research/productivity content`;

    // Make request to Gemini API
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      jsonText = responseText.split('```')[1].split('```')[0].trim();
    }
    
    // Parse the JSON response
    const analysis = JSON.parse(jsonText);

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
    
    // Use the pre-existing domain info
    analysis.domainCategory = domainInfo.category;
    analysis.domainReason = domainInfo.reason;
    
    // Attach domain for reference
    analysis.domain = domain;
    
    // Add mixed content information
    analysis.knownMixedContent = isKnownMixedContent || false;
    analysis.skipDomainCheck = domainInfo.skipDomainCheck || false;
    
    // Set the analysis source
    analysis.analysisSource = 'title-analysis';
    
    console.log(`Title analysis complete for ${domain}. Result: ${analysis.isProductive ? 'productive' : 'non-productive'} (score: ${analysis.score})`);

    return analysis;
  } catch (error) {
    console.error('Error analyzing title with domain info:', error);
    
    // Increment error counter
    apiUsageStats.errors++;
    
    return {
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Error during title analysis: ' + error.message,
      domainCategory: domainInfo.category,
      domainReason: domainInfo.reason,
      domain: domain,
      analysisSource: 'title-analysis-error'
    };
  }
}

/**
 * Analyze content with pre-existing domain information
 */
async function analyzeContentWithDomainInfo(title, content, url = '', domain = '', domainInfo) {
  try {
    console.log(`Analyzing content for context-dependent domain ${domain}, content length: ${content.length}`);
    
    // Check if this is a known mixed content domain (YouTube, Reddit, etc.)
    const isKnownMixedContent = domainInfo.knownMixedContent || 
                              (domain === 'youtube.com' || domain === 'youtu.be' || 
                               domain === 'reddit.com' || domain === 'twitter.com' || 
                               domain === 'x.com');
    
    // Limit content length to avoid token limits
    const truncatedContent = content.substring(0, 2000);
    
    // Special handling for YouTube to improve analysis
    let enhancedPrompt = '';
    if (domain === 'youtube.com' || domain === 'youtu.be') {
      enhancedPrompt = `When analyzing YouTube content:
- Educational videos, tutorials, lectures, documentaries are productive
- Entertainment, gaming, music videos, comedy are non-productive
- Consider the video title, channel name, and content carefully to determine purpose
- If a video has educational value, classify it as productive even if it's entertainment-adjacent
`;
    }
    
    // Create compact content analysis prompt to minimize token usage
    const prompt = `Analyze: "${title}" (URL: ${url})
Domain ${domain} is "${domainInfo.category}": "${domainInfo.reason}"
${enhancedPrompt}Content: """${truncatedContent}"""
Return only JSON: {"isProductive":true/false,"score":0-1,"categories":[],"explanation":"reason"}
Productive = educational/work/research/productivity content`;

    // Call the Gemini API
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Extract JSON
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      jsonText = responseText.split('```')[1].split('```')[0].trim();
    }
    
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const analysisResult = JSON.parse(jsonMatch[0]);
      
      // Normalize the score to 0-100 range if it's in 0-1
      let score = analysisResult.score || 0;
      if (score <= 1 && score >= 0) {
        score = Math.round(score * 100);
      } else {
        score = Math.min(100, Math.max(0, score));
      }
      
      const result = {
        isProductive: analysisResult.isProductive || false,
        score: score,
        categories: analysisResult.categories || [],
        explanation: analysisResult.explanation || "No explanation provided",
        domainCategory: domainInfo.category,
        domainReason: domainInfo.reason,
        domain: domain,
        analysisSource: 'content-analysis',
        knownMixedContent: isKnownMixedContent || false,
        skipDomainCheck: domainInfo.skipDomainCheck || false
      };
      
      console.log(`Content analysis complete for ${domain}. Result: ${result.isProductive ? 'productive' : 'non-productive'} (score: ${result.score})`);
      
      return result;
    } else {
      throw new Error("Failed to extract JSON from API response");
    }
  } catch (error) {
    console.error("Error in content analysis with domain info:", error);
    
    // Increment error counter
    apiUsageStats.errors++;
    
    // Attempt to fall back to title-only analysis
    console.log(`Falling back to title analysis for ${domain} due to content analysis error`);
    try {
      return await analyzeTitleWithDomainInfo(title, url, domain, domainInfo);
    } catch (fallbackError) {
      console.error("Error in fallback title analysis:", fallbackError);
      
      // Return a default response if all else fails
      return {
        isProductive: false,
        score: 0,
        categories: [],
        explanation: 'Error during content analysis: ' + error.message,
        domainCategory: domainInfo.category,
        domainReason: domainInfo.reason,
        domain: domain,
        analysisSource: 'content-analysis-error'
      };
    }
  }
}

// Original functions preserved for backward compatibility
async function analyzeTabTitle(title, url, domain) {
  // Use the new unified approach
  return await analyzeTab(title, url, domain);
}

async function analyzeContent(title, content, url = '', domain = '') {
  // Use the new unified approach
  return await analyzeTab(title, url, domain, content);
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

// API usage statistics endpoint
app.get('/api/usage-stats', (req, res) => {
  // Check if stats should be reset
  checkAndResetApiStats();
  
  res.json({
    success: true,
    stats: apiUsageStats
  });
});

// Save tab data and analyze productive content
app.post('/api/tabs', trackApiUsage('title'), async (req, res) => {
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
    
    console.log(`API request to analyze tab: ${tab.id}, domain: ${domain}, title: ${cleanTitle}`);

    // Use the optimized unified analyze function
    // This follows the prioritization pattern:
    // 1. Check domain categorization first (from cache if available)
    // 2. Only proceed to title/content analysis for context-dependent domains
    const analysis = await analyzeTab(cleanTitle, tab.url, domain);
    
    console.log(`Tab analysis complete for ${domain}. Result: ${analysis.isProductive ? 'productive' : 'non-productive'} (score: ${analysis.score})`);
    
    // Include detailed API usage statistics in response
    res.json({ 
      success: true, 
      id: tab.id, 
      analysis: {
        isProductive: analysis.isProductive,
        score: analysis.score,
        categories: analysis.categories,
        explanation: analysis.explanation,
        domainCategory: analysis.domainCategory,
        domainReason: analysis.domainReason,
        analysisSource: analysis.analysisSource || 'unknown'
      },
      apiUsage: {
        dailyCalls: apiUsageStats.dailyCalls,
        titleAnalysisCalls: apiUsageStats.titleAnalysisCalls,
        domainCategorizationCalls: apiUsageStats.domainCategorizationCalls,
        lastReset: apiUsageStats.lastReset,
        tokensUsed: apiUsageStats.tokensUsed
      }
    });
  } catch (error) {
    console.error('Error processing tab data:', error);
    apiUsageStats.errors++;
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Analyze a title directly from the frontend
app.post('/api/analyze-title', trackApiUsage('title'), async (req, res) => {
  try {
    const { title, url, domain } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    
    // Sanitize title
    const cleanTitle = validator.escape(title);
    
    // Use the provided domain or extract it from URL
    const extractedDomain = domain || (url ? extractDomain(url) : '');
    
    console.log(`API request to analyze title: ${cleanTitle} for domain ${extractedDomain}`);
    
    // Use the optimized unified analyze function - this will:
    // 1. First check domain-level categorization (always-productive/always-nonproductive)
    // 2. Only if domain is context-dependent, analyze the title content
    // This approach minimizes API calls to Gemini for titles on already categorized domains
    const analysis = await analyzeTab(cleanTitle, url || '', extractedDomain);
    
    console.log(`Analysis complete for ${extractedDomain}. Result: ${analysis.isProductive ? 'productive' : 'non-productive'} (score: ${analysis.score})`);
    
    // Include detailed API usage statistics in response
    res.json({
      success: true,
      ...analysis,
      apiUsage: {
        dailyCalls: apiUsageStats.dailyCalls,
        titleAnalysisCalls: apiUsageStats.titleAnalysisCalls,
        domainCategorizationCalls: apiUsageStats.domainCategorizationCalls,
        lastReset: apiUsageStats.lastReset,
        tokensUsed: apiUsageStats.tokensUsed
      }
    });
  } catch (error) {
    console.error('Error analyzing title:', error);
    apiUsageStats.errors++;
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Analyze content directly from the frontend or browser extension
app.post('/api/analyze-content', trackApiUsage('content'), async (req, res) => {
  try {
    const { title, url, content } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ success: false, error: 'Title and content are required' });
    }
    
    // Sanitize inputs
    const cleanTitle = validator.escape(title);
    
    // Extract domain
    const domain = url ? extractDomain(url) : '';
    
    console.log(`API request to analyze content for domain ${domain}, content length: ${content.length}`);
    
    // Use the optimized unified analyze function with content
    // This follows the prioritization pattern:
    // 1. Check domain categorization first (using cache where available)
    // 2. Only analyze content for context-dependent domains
    // 3. Skip content analysis entirely for known always-productive/always-nonproductive domains
    const analysis = await analyzeTab(cleanTitle, url || '', domain, content);
    
    console.log(`Content analysis complete for ${domain}. Result: ${analysis.isProductive ? 'productive' : 'non-productive'} (score: ${analysis.score})`);
    
    // Include detailed API usage statistics in response
    res.json({
      success: true,
      ...analysis,
      apiUsage: {
        dailyCalls: apiUsageStats.dailyCalls,
        contentAnalysisCalls: apiUsageStats.contentAnalysisCalls,
        domainCategorizationCalls: apiUsageStats.domainCategorizationCalls,
        lastReset: apiUsageStats.lastReset,
        tokensUsed: apiUsageStats.tokensUsed
      }
    });
  } catch (error) {
    console.error('Error analyzing content:', error);
    apiUsageStats.errors++;
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

// Add a domain categorization API endpoint
app.post('/api/domain-category', trackApiUsage('domain'), async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ success: false, error: 'Domain parameter is required' });
    }
    
    // Use the getDomainCategory function
    const categorization = await getDomainCategory(domain);
    
    // Return the categorization
    res.json({
      success: true,
      domain: domain,
      categorization: {
        category: categorization.category,
        reason: categorization.reason,
        urlPatterns: categorization.urlPatterns,
        timestamp: new Date(categorization.timestamp).toISOString()
      },
      apiUsage: {
        dailyCalls: apiUsageStats.dailyCalls,
        lastReset: apiUsageStats.lastReset
      }
    });
  } catch (error) {
    console.error('Error categorizing domain:', error);
    apiUsageStats.errors++;
    res.status(500).json({ success: false, error: 'Internal server error. Please try again later.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
