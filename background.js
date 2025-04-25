/**
 * Background script for BattleTask - Focus Extension
 * 
 * This script:
 * 1. Communicates with the backend server for productivity content analysis
 * 2. Tracks tab activity and provides data to the popup
 */

// Configuration
const CONFIG = {
  BACKEND_URL: 'https://battletask-279027565964.us-central1.run.app',
  UPDATE_INTERVAL: 1000, // Update every second for accurate time tracking
  ACTIVITY_TIMEOUT: 30000,
  PRODUCTIVITY_THRESHOLD: 50, // Threshold for determining if content is productive
  CACHE_EXPIRY: 7 * 24 * 60 * 60 * 1000, // Cache expiry time (7 days in milliseconds)
  ANALYSIS_TIMEOUT: 10000, // 10 seconds timeout for analysis
  MAX_TIME_GAP: 120000, // Allow up to 2 minutes between updates (handles suspension)
  PRODUCTIVE_MODE_BLOCK_DELAY: 30000, // 30 seconds before blocking unproductive content
  CONTENT_LOAD_DELAY: 2500, // 2.5 seconds delay to allow content to load before analysis
  SPA_SITES: ['reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com', 'instagram.com', 'linkedin.com']
};

// State tracking
let currentTab = {
  id: null,
  url: '',
  domain: '',
  title: '',
  startTime: null,
  lastUpdateTime: null,
  isProductive: false,
  score: 0,
  categories: [],
  explanation: 'Analyzing...',
  lastUpdated: Date.now(),
  isAnalyzing: true
};

// Storage for time tracking
let stats = {
  productiveTime: 0,
  nonProductiveTime: 0,
  domainVisits: {},
  lastReset: Date.now(),
  analyzingDomains: {}
};

// Domain-specific tracking
let domainTracking = {};

// URL analysis cache
let urlCache = {};

// Visibility tracking
let isWindowActive = false;
let isTabVisible = false;
let lastActiveTime = null;

// Productive mode state
let productiveMode = {
  enabled: false,
  unproductiveStartTime: null,
  activeTabTime: 0, // Legacy (single timer)
  lastActiveTimestamp: null,
  urlTimers: {} // Map of url -> accumulated activeTabTime
};

// Blocked URLs
let blockedUrls = {};

// User-blocked domains (set in popup)
let userBlockedDomains = [];

// API call rate limiting
let apiCallCount = 0;
let apiCallDate = null;

// Daily stats reset date
let statsResetDate = null;

// Track last analyzed URL with hash for SPAs
let lastAnalyzedUrlWithHash = '';

// Initialize the extension
async function init() {
  console.log('BattleTask background initializing...');
  
  // Load saved stats and cache
  const data = await chrome.storage.local.get(['stats', 'domainTracking', 'urlCache', 'productiveMode', 'blockedUrls', 'userBlockedDomains', 'apiCallCount', 'apiCallDate', 'statsResetDate']);
  if (data.stats) stats = data.stats;
  if (data.domainTracking) domainTracking = data.domainTracking;
  if (data.urlCache) urlCache = data.urlCache;
  if (data.productiveMode) productiveMode = data.productiveMode;
  if (data.blockedUrls) blockedUrls = data.blockedUrls;
  if (data.userBlockedDomains) userBlockedDomains = data.userBlockedDomains;
  if (typeof data.apiCallCount === 'number') apiCallCount = data.apiCallCount;
  if (typeof data.apiCallDate === 'string') apiCallDate = data.apiCallDate;
  if (typeof data.statsResetDate === 'string') statsResetDate = data.statsResetDate;
  
  // Daily stats reset on startup
  await maybeResetStatsDaily();
  
  // Ensure all productive mode properties exist
  if (!productiveMode.activeTabTime) productiveMode.activeTabTime = 0;
  if (!productiveMode.lastActiveTimestamp) productiveMode.lastActiveTimestamp = null;
  
  console.log('Loaded productive mode state:', productiveMode);
  
  // Initialize analyzingDomains if it doesn't exist
  if (!stats.analyzingDomains) {
    stats.analyzingDomains = {};
  }
  
  // Clean expired cache entries
  cleanExpiredCache();
  
  // Set up event listeners for tab changes
  chrome.tabs.onActivated.addListener(handleTabActivated);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  
  // Add listener to check for blocked URLs
  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    // Only check when the URL changes and productive mode is enabled
    if (changeInfo.url && productiveMode.enabled) {
      // Check if this exact URL is in the blocked list
      if (blockedUrls[changeInfo.url]) {
        console.log(`Preventing navigation to blocked URL: ${changeInfo.url}`);
        
        // Create a redirect URL with the blocked URL as a parameter
        const redirectUrl = `blocked.html?url=${encodeURIComponent(changeInfo.url)}`;
        
        // Redirect to the blocked page
        chrome.tabs.update(tabId, { url: redirectUrl });
      }
    }
  });
  
  // Listen for changes to userBlockedDomains from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'userBlockedDomainsChanged') {
      userBlockedDomains = message.domains || [];
      chrome.storage.local.set({ userBlockedDomains });
    }
  });
  
  // Set up message listeners
  chrome.runtime.onMessage.addListener(handleMessages);
  
  // Set up visibility change listeners
  setupVisibilityTracking();
  
  // Start periodic updates for time tracking
  setInterval(async () => { await updateTimeTracking(); }, CONFIG.UPDATE_INTERVAL);
  
  // Get the current active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    await handleTabActivated({ tabId: tabs[0].id });
  }
  
  // Set up content script for SPA monitoring
  setupSPAContentScripts();
  
  console.log('BattleTask background initialized');
}

/**
 * Set up visibility tracking to monitor browser and tab visibility
 */
function setupVisibilityTracking() {
  // Listen for window focus/blur events
  chrome.windows.onFocusChanged.addListener(windowId => {
    isWindowActive = windowId !== chrome.windows.WINDOW_ID_NONE;
    console.log(`Window focus changed: ${isWindowActive ? 'focused' : 'unfocused'}`);
    
    // Force a visibility check when window focus changes
    checkTabVisibility();
  });
  
  // Listen for tab visibility changes via content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'visibilityChange') {
      isTabVisible = message.isVisible;
      console.log(`Tab visibility changed: ${isTabVisible ? 'visible' : 'hidden'}`);
      sendResponse({ success: true });
    }
    return true;
  });
  
  // Check initial window state
  chrome.windows.getCurrent(window => {
    isWindowActive = window.focused;
    console.log(`Initial window state: ${isWindowActive ? 'focused' : 'unfocused'}`);
    
    // Force initial visibility check
    checkTabVisibility();
  });
  
  // Set up periodic visibility checks (every 10 seconds)
  setInterval(checkTabVisibility, 10000);
}

/**
 * Check tab visibility by querying the active tab
 * This helps recover from missed visibility events
 */
async function checkTabVisibility() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].id === currentTab.id) {
      // If this is our current tracked tab and it's active, it must be visible
      isTabVisible = true;
    }
  } catch (error) {
    console.error('Error checking tab visibility:', error);
  }
}

/**
 * Clean expired cache entries
 */
function cleanExpiredCache() {
  const now = Date.now();
  let cacheChanged = false;
  
  Object.keys(urlCache).forEach(url => {
    if (now - urlCache[url].timestamp > CONFIG.CACHE_EXPIRY) {
      delete urlCache[url];
      cacheChanged = true;
    }
  });
  
  if (cacheChanged) {
    chrome.storage.local.set({ urlCache });
  }
}

/**
 * Handle tab activation (user switches tabs)
 */
async function handleTabActivated(activeInfo) {
  try {
    // Get the tab information
    const tab = await chrome.tabs.get(activeInfo.tabId);
    
    // --- User-blocked domains enforcement ---
    if (productiveMode.enabled && tab.url) {
      const domain = extractDomain(tab.url);
      if (userBlockedDomains && userBlockedDomains.includes(domain)) {
        const redirectUrl = `blocked.html?url=${encodeURIComponent(tab.url)}`;
        chrome.tabs.update(tab.id, { url: redirectUrl });
        return;
      }
    }
    // --- Persist timer for previous non-productive tab ---
    if (productiveMode.enabled && productiveMode.unproductiveStartTime && currentTab && !currentTab.isProductive && !blockedUrls[currentTab.url]) {
      // Save the elapsed time for the previous tab
      const prevUrl = currentTab.url;
      const now = Date.now();
      if (productiveMode.lastActiveTimestamp) {
        const elapsed = now - productiveMode.lastActiveTimestamp;
        if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
        productiveMode.urlTimers[prevUrl] = (productiveMode.urlTimers[prevUrl] || 0) + elapsed;
      }
      productiveMode.activeTabTime = 0;
      productiveMode.lastActiveTimestamp = null;
      productiveMode.unproductiveStartTime = null;
      chrome.storage.local.set({ productiveMode });
    }
    // ---
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) { return; }
    if (productiveMode.enabled && blockedUrls[tab.url]) {
      const redirectUrl = `blocked.html?url=${encodeURIComponent(tab.url)}`;
      chrome.tabs.update(tab.id, { url: redirectUrl });
      return;
    }
    const domain = extractDomain(tab.url);
    currentTab = {
      id: tab.id,
      url: tab.url,
      domain: domain,
      title: tab.title,
      startTime: Date.now(),
      lastUpdateTime: null,
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Analyzing...',
      lastUpdated: Date.now(),
      isAnalyzing: true
    };
    chrome.storage.local.set({ currentTab });
    // --- Resume timer for this non-productive tab ---
    if (productiveMode.enabled && !currentTab.isProductive && !blockedUrls[tab.url]) {
      productiveMode.unproductiveStartTime = Date.now();
      // Resume from stored time if exists
      if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
      productiveMode.activeTabTime = productiveMode.urlTimers[tab.url] || 0;
      productiveMode.lastActiveTimestamp = Date.now();
      chrome.storage.local.set({ productiveMode });
    }
    // ---
    analyzeTabTitle(tab.title, tab.url, true); // true = force analysis
    updateExtensionIcon(currentTab);
  } catch (error) {
    console.error('Error in handleTabActivated:', error);
  }
}

/**
 * Handle tab updates (URL changes within a tab)
 */
async function handleTabUpdated(tabId, changeInfo, tab) {
  try {
    // Only process if this is the active tab and the URL changed
    if (!changeInfo.url || !tab.active) {
      return;
    }
    
    // Check if this URL is already blocked in productive mode
    if (productiveMode.enabled && blockedUrls[changeInfo.url]) {
      console.log(`Preventing navigation to blocked URL: ${changeInfo.url}`);
      
      // Create a redirect URL with the blocked URL as a parameter
      const redirectUrl = `blocked.html?url=${encodeURIComponent(changeInfo.url)}`;
      
      // Redirect to the blocked page
      chrome.tabs.update(tabId, { url: redirectUrl });
      return;
    }
    
    // --- User-blocked domains enforcement ---
    if (productiveMode.enabled) {
      const domain = extractDomain(tab.url);
      if (userBlockedDomains && userBlockedDomains.includes(domain)) {
        const redirectUrl = `blocked.html?url=${encodeURIComponent(tab.url)}`;
        chrome.tabs.update(tab.id, { url: redirectUrl });
        return;
      }
    }
    // ---
    // Skip chrome:// URLs and other special URLs
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }
    
    // Extract domain from URL
    const domain = extractDomain(tab.url);
    
    // Update current tab
    currentTab = {
      id: tab.id,
      url: tab.url,
      domain: domain,
      title: tab.title || '',
      startTime: Date.now(),
      lastUpdateTime: null, // Will be set on first update
      isProductive: false, // Default to non-productive until analyzed
      score: 0,
      categories: [],
      explanation: 'Analyzing...',
      lastUpdated: Date.now(),
      isAnalyzing: true
    };
    
    // Save current tab
    chrome.storage.local.set({ currentTab });
    
    // For SPA sites, we need to wait a bit for content to load and extract more data
    const isSPA = CONFIG.SPA_SITES.some(site => domain.includes(site));
    
    // Track the full URL with hash for SPAs
    const urlWithHash = tab.url;
    
    // Only analyze if this is a new URL (including hash) we haven't analyzed yet
    if (urlWithHash !== lastAnalyzedUrlWithHash) {
      lastAnalyzedUrlWithHash = urlWithHash;
      
      if (isSPA) {
        // Wait for content to load
        setTimeout(() => {
          // Get updated tab info
          chrome.tabs.get(tabId, (updatedTab) => {
            if (chrome.runtime.lastError) {
              console.error('Error getting updated tab:', chrome.runtime.lastError);
              analyzeTabTitle(tab.title, tab.url, true);
              return;
            }
            
            // Extract content from the page for better analysis
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              function: extractPageContent
            }, (results) => {
              if (chrome.runtime.lastError) {
                console.error('Error executing script:', chrome.runtime.lastError);
                analyzeTabTitle(updatedTab.title, updatedTab.url, true);
                return;
              }
              
              if (results && results[0] && results[0].result) {
                const content = results[0].result;
                analyzeContent(updatedTab.title, updatedTab.url, content, true);
              } else {
                analyzeTabTitle(updatedTab.title, updatedTab.url, true);
              }
            });
          });
        }, CONFIG.CONTENT_LOAD_DELAY);
      } else {
        // Always analyze on URL change (no cache)
        analyzeTabTitle(tab.title, tab.url, true);
      }
    }
    
    updateExtensionIcon(currentTab);
  } catch (error) {
    console.error('Error in handleTabUpdated:', error);
  }
}

/**
 * Apply cached analysis results
 */
function applyUrlCache(url) {
  if (urlCache[url]) {
    const cachedData = urlCache[url];
    console.log(`Using cached data for ${url}`);
    
    // Update current tab with cached data
    currentTab.isAnalyzing = false;
    currentTab.startTime = Date.now();
    currentTab.isProductive = cachedData.isProductive;
    currentTab.score = cachedData.score;
    currentTab.categories = cachedData.categories || [];
    currentTab.explanation = cachedData.explanation || 'No explanation provided (cached)';
    currentTab.lastUpdated = Date.now();
    
    // Remove from analyzing domains
    if (stats.analyzingDomains[currentTab.domain]) {
      delete stats.analyzingDomains[currentTab.domain];
    }
    
    // Save current tab data
    chrome.storage.local.set({ currentTab, stats });
    
    // Update the extension icon immediately based on the cached result
    updateExtensionIcon(currentTab);
    
    console.log(`Applied cached data: ${currentTab.isProductive ? 'Productive' : 'Non-productive'} (${currentTab.score}/100)`);
    return true;
  }
  return false;
}

/**
 * Analyze tab title using backend server
 */
async function analyzeTabTitle(title, url, force=false) {
  // Skip if no title or URL
  if (!title || !url) {
    console.log('Skipping analysis: No title or URL');
    return;
  }
  
  // Skip chrome:// urls and extension pages
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    console.log('Skipping analysis: Chrome or extension URL');
    return;
  }
  
  // Check for manual override
  const overrides = (await chrome.storage.local.get('overrides')).overrides || {};
  if (overrides[url] === true) {
    updateTabWithAnalysis({ isProductive: true, score: 100, categories: ['Manual'], explanation: 'User override: productive' });
    return;
  }
  if (overrides[url] === false) {
    updateTabWithAnalysis({ isProductive: false, score: 0, categories: ['Manual'], explanation: 'User override: non-productive' });
    return;
  }
  
  // API call rate limiting
  const today = getTodayString();
  if (apiCallDate !== today) {
    apiCallDate = today;
    apiCallCount = 0;
    chrome.storage.local.set({ apiCallDate, apiCallCount });
  }
  if (apiCallCount >= 300) {
    console.warn('API call limit reached for today (300). Analysis skipped.');
    console.log('Current API call count:', apiCallCount);
    
    // Extract domain from URL to check if it's in user-blocked domains
    const domain = extractDomain(url);
    
    // If domain is in user-blocked domains, mark as non-productive
    // Otherwise, mark as productive (fallback to user preferences instead of API)
    if (userBlockedDomains && userBlockedDomains.includes(domain)) {
      updateTabWithAnalysis({ isProductive: false, score: 0, categories: ['User Blocked'], explanation: 'Domain is in user-blocked list. API limit reached.' });
    } else {
      updateTabWithAnalysis({ isProductive: true, score: CONFIG.PRODUCTIVITY_THRESHOLD, categories: ['API Limit'], explanation: 'API limit reached. Defaulting to productive since domain is not blocked by user.' });
    }
    return;
  }
  
  // Only use cache if not forced
  if (!force && urlCache[url]) {
    console.log('Using cached analysis for:', url);
    updateTabWithAnalysis(urlCache[url]);
    return;
  }
  
  console.log('Analyzing title:', title);
  
  try {
    // Set up analysis timeout
    const analysisTimeout = setTimeout(() => {
      if (currentTab.isAnalyzing) {
        console.log(`Analysis timeout for ${url}`);
        updateTabWithAnalysis({ isProductive: false, score: 0, categories: [], explanation: 'Analysis timed out' });
      }
    }, CONFIG.ANALYSIS_TIMEOUT);
    
    // Prepare request data
    const domain = extractDomain(url);
    const requestData = { url: url, domain: domain, title: title };
    
    // Increment API call count
    apiCallCount++;
    chrome.storage.local.set({ apiCallCount, apiCallDate });
    
    // Send request to backend
    const response = await fetch(`${CONFIG.BACKEND_URL}/api/analyze-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    
    // Clear the timeout since we got a response
    clearTimeout(analysisTimeout);
    
    // Check if response is ok
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }
    
    // Parse response
    const analysis = await response.json();
    
    // Normalize score to ensure it's in 0-100 range
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
    
    // Determine if the content is productive based on the score threshold
    const isProductive = analysis.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
    
    // Cache the result
    urlCache[url] = { isProductive, score: analysis.score, categories: analysis.categories, explanation: analysis.explanation, timestamp: Date.now() };
    
    // Save cache
    chrome.storage.local.set({ urlCache });
    
    // Update tab data
    updateTabWithAnalysis({ isProductive, score: analysis.score, categories: analysis.categories, explanation: analysis.explanation });
    
  } catch (error) {
    console.error('Error analyzing title:', error);
    
    // Set default values for error
    updateTabWithAnalysis({ isProductive: false, score: 0, categories: [], explanation: `Error analyzing content: ${error.message}` });
  }
}

/**
 * Analyze content with both title and extracted content
 */
async function analyzeContent(title, url, extractedContent, force=false) {
  // Skip if no title or URL
  if (!title || !url) {
    console.log('Skipping analysis: No title or URL');
    return;
  }
  
  // Skip chrome:// urls and extension pages
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    console.log('Skipping analysis: Chrome or extension URL');
    return;
  }
  
  // Check for manual override
  const overrides = (await chrome.storage.local.get('overrides')).overrides || {};
  if (overrides[url] === true) {
    updateTabWithAnalysis({ isProductive: true, score: 100, categories: ['Manual'], explanation: 'User override: productive' });
    return;
  }
  if (overrides[url] === false) {
    updateTabWithAnalysis({ isProductive: false, score: 0, categories: ['Manual'], explanation: 'User override: non-productive' });
    return;
  }
  
  // API call rate limiting
  const today = getTodayString();
  if (apiCallDate !== today) {
    apiCallDate = today;
    apiCallCount = 0;
    chrome.storage.local.set({ apiCallDate, apiCallCount });
  }
  if (apiCallCount >= 300) {
    console.warn('API call limit reached for today (300). Analysis skipped.');
    updateTabWithAnalysis({ isProductive: false, score: 0, categories: [], explanation: 'Daily analysis limit reached. Try again tomorrow.' });
    return;
  }
  
  // Only use cache if not forced
  if (!force && urlCache[url]) {
    console.log('Using cached analysis for:', url);
    updateTabWithAnalysis(urlCache[url]);
    return;
  }
  
  console.log('Analyzing content for:', url);
  
  try {
    // Set up analysis timeout
    const analysisTimeout = setTimeout(() => {
      if (currentTab.isAnalyzing) {
        console.log(`Analysis timeout for ${url}`);
        updateTabWithAnalysis({ isProductive: false, score: 0, categories: [], explanation: 'Analysis timed out' });
      }
    }, CONFIG.ANALYSIS_TIMEOUT);
    
    // Prepare request data with extracted content
    const domain = extractDomain(url);
    const requestData = {
      title: title,
      content: extractedContent.content || '',
      siteName: extractedContent.siteName || '',
      url: url,
      domain: domain
    };
    
    // Increment API call count
    apiCallCount++;
    chrome.storage.local.set({ apiCallCount, apiCallDate });
    
    // Send request to backend
    const response = await fetch(`${CONFIG.BACKEND_URL}/api/analyze-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData)
    });
    
    // Clear the timeout since we got a response
    clearTimeout(analysisTimeout);
    
    // Check if response is ok
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }
    
    // Parse response
    const analysis = await response.json();
    
    // Process analysis result (same as in analyzeTabTitle)
    if (!analysis.score && analysis.score !== 0) analysis.score = 0;
    if (typeof analysis.score === 'string') analysis.score = parseFloat(analysis.score);
    if (analysis.score <= 1 && analysis.score >= 0) analysis.score = Math.round(analysis.score * 100);
    else analysis.score = Math.min(100, Math.max(0, analysis.score));
    
    const isProductive = analysis.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
    
    // Cache the result
    urlCache[url] = {
      isProductive,
      score: analysis.score,
      categories: analysis.categories || [],
      explanation: analysis.explanation || 'No explanation provided',
      timestamp: Date.now()
    };
    
    // Save cache
    chrome.storage.local.set({ urlCache });
    
    // Update tab data
    updateTabWithAnalysis({
      isProductive,
      score: analysis.score,
      categories: analysis.categories || [],
      explanation: analysis.explanation || 'No explanation provided'
    });
    
  } catch (error) {
    console.error('Error analyzing content:', error);
    
    // Fall back to title-only analysis
    analyzeTabTitle(title, url, force);
  }
}

/**
 * Update tab with analysis results
 */
function updateTabWithAnalysis(analysisResult) {
  // Update current tab data
  currentTab.isAnalyzing = false;
  currentTab.startTime = Date.now(); // Set start time now that analysis is complete
  currentTab.isProductive = analysisResult.isProductive;
  currentTab.score = analysisResult.score;
  currentTab.categories = analysisResult.categories || [];
  currentTab.explanation = analysisResult.explanation || 'No explanation provided';
  currentTab.lastUpdated = Date.now();
  
  // Remove from analyzing domains
  if (stats.analyzingDomains[currentTab.domain]) {
    delete stats.analyzingDomains[currentTab.domain];
  }
  
  // Save current tab data
  chrome.storage.local.set({ currentTab, stats });
  
  // Update the extension icon based on the analysis result
  updateExtensionIcon(currentTab);
  
  console.log(`Analysis complete: ${currentTab.isProductive ? 'Productive' : 'Non-productive'} (${currentTab.score}/100)`);
}

/**
 * Function to extract content from the page
 */
function extractPageContent() {
  try {
    // Get the page title
    const pageTitle = document.title;
    
    // Get main content based on site
    let mainContent = '';
    let siteName = '';
    
    // Reddit-specific extraction
    if (window.location.hostname.includes('reddit.com')) {
      siteName = 'Reddit';
      
      // Get current URL with hash for accurate tracking
      const currentUrl = window.location.href;
      
      // Get post title if on a post page
      const postTitle = document.querySelector('h1')?.innerText || '';
      
      // Get subreddit name
      let subreddit = '';
      // From URL path
      const subredditMatch = window.location.pathname.match(/\/r\/([^\/]+)/);
      if (subredditMatch) {
        subreddit = subredditMatch[1];
      }
      
      // Get post content - try multiple selectors for different Reddit versions
      let postContent = '';
      const postSelectors = [
        '[data-testid="post-container"] [data-click-id="text"] p',
        '.Post__content .RichTextJSON-root p',
        '.expando .usertext-body .md',
        'div[data-click-id="text"] p'
      ];
      
      for (const selector of postSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          postContent = element.innerText;
          break;
        }
      }
      
      // Get comments - try multiple selectors
      let comments = '';
      const commentElements = document.querySelectorAll('[data-testid="comment"] p, .Comment .RichTextJSON-root p, .sitetable.nestedlisting .entry .md p');
      if (commentElements.length > 0) {
        comments = Array.from(commentElements).slice(0, 5).map(c => c.innerText).join(' ');
      }
      
      mainContent = `r/${subreddit} ${postTitle} ${postContent} ${comments}`;
      
      // Add current URL path for context
      mainContent += ' ' + window.location.pathname;
    }
    // YouTube-specific extraction
    else if (window.location.hostname.includes('youtube.com')) {
      siteName = 'YouTube';
      // Get video title
      const videoTitle = document.querySelector('h1.title')?.innerText || document.querySelector('h1')?.innerText || '';
      // Get channel name
      const channelName = document.querySelector('#owner-name a')?.innerText || '';
      // Get video description
      const description = document.querySelector('#description-inline-expander')?.innerText || '';
      
      mainContent = `${videoTitle} ${channelName} ${description}`;
    }
    // Twitter/X-specific extraction
    else if (window.location.hostname.includes('twitter.com') || window.location.hostname.includes('x.com')) {
      siteName = 'Twitter/X';
      // Get tweet text
      const tweetText = document.querySelector('[data-testid="tweetText"]')?.innerText || '';
      // Get profile name if on profile
      const profileName = document.querySelector('h2[aria-level="2"]')?.innerText || '';
      
      mainContent = `${tweetText} ${profileName}`;
    }
    // Facebook-specific extraction
    else if (window.location.hostname.includes('facebook.com')) {
      siteName = 'Facebook';
      // Get post content
      const postContent = document.querySelector('[data-ad-preview="message"]')?.innerText || '';
      // Get page title
      const pageTitle = document.querySelector('h1')?.innerText || '';
      
      mainContent = `${pageTitle} ${postContent}`;
    }
    
    // If we couldn't extract specific content, get general page content
    if (!mainContent) {
      // Get all headings
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 3).map(h => h.innerText).join(' ');
      // Get main content paragraphs
      const paragraphs = Array.from(document.querySelectorAll('p')).slice(0, 5).map(p => p.innerText).join(' ');
      
      mainContent = `${headings} ${paragraphs}`;
    }
    
    return {
      title: pageTitle,
      content: mainContent.substring(0, 1000), // Limit content length
      siteName: siteName,
      url: window.location.href // Include full URL with hash
    };
  } catch (e) {
    console.error('Error extracting page content:', e);
    return null;
  }
}

/**
 * Handle messages from popup
 */
function handleMessages(message, sender, sendResponse) {
  try {
    // Handle different message actions
    switch (message.action) {
      case 'getCurrentTab':
        // Return the current tab data
        sendResponse({ success: true, data: currentTab });
        break;
        
      case 'getStats':
        // Calculate productive percentage
        const totalTime = stats.productiveTime + stats.nonProductiveTime;
        const productivePercentage = totalTime > 0 ? 
          Math.round((stats.productiveTime / totalTime) * 100) : 0;
        
        // Get top productive and non-productive domains
        const productiveDomains = [];
        const nonProductiveDomains = [];
        
        // Process domain tracking data
        Object.keys(domainTracking).forEach(domain => {
          const tracking = domainTracking[domain];
          
          // Add to productive domains if there's productive time
          if (tracking.productiveTime > 0) {
            productiveDomains.push({
              domain: domain,
              timeSpent: tracking.productiveTime,
              score: tracking.productiveScore,
              totalTimeSpent: tracking.productiveTime + tracking.nonProductiveTime,
              productivePercentage: Math.round((tracking.productiveTime / (tracking.productiveTime + tracking.nonProductiveTime)) * 100)
            });
          }
          
          // Add to non-productive domains if there's non-productive time
          if (tracking.nonProductiveTime > 0) {
            nonProductiveDomains.push({
              domain: domain,
              timeSpent: tracking.nonProductiveTime,
              score: tracking.nonProductiveScore,
              totalTimeSpent: tracking.productiveTime + tracking.nonProductiveTime,
              productivePercentage: Math.round((tracking.productiveTime / (tracking.productiveTime + tracking.nonProductiveTime)) * 100)
            });
          }
        });
        
        // Sort domains by time spent (descending)
        productiveDomains.sort((a, b) => b.timeSpent - a.timeSpent);
        nonProductiveDomains.sort((a, b) => b.timeSpent - a.timeSpent);
        
        // Get cache size
        const cacheSize = Object.keys(urlCache).length;
        
        // Return stats
        sendResponse({
          success: true,
          data: {
            productiveTime: stats.productiveTime,
            nonProductiveTime: stats.nonProductiveTime,
            productivePercentage: productivePercentage,
            productiveDomains: productiveDomains.slice(0, 10), // Top 10
            nonProductiveDomains: nonProductiveDomains.slice(0, 10), // Top 10
            cacheSize: cacheSize
          }
        });
        break;
        
      case 'resetStats':
        // Reset all statistics
        resetStats();
        sendResponse({ success: true });
        break;
        
      case 'clearCache':
        // Clear URL analysis cache
        urlCache = {};
        chrome.storage.local.set({ urlCache });
        sendResponse({ success: true });
        break;
        
      case 'setTheme':
        // Set theme preference
        chrome.storage.local.get(['settings'], function(data) {
          const settings = data.settings || {};
          settings.theme = message.theme;
          chrome.storage.local.set({ settings });
        });
        sendResponse({ success: true });
        break;
        
      case 'setProductiveMode':
        // Set productive mode state
        productiveMode.enabled = message.enabled;
        productiveMode.unproductiveStartTime = null; // Reset timer
        productiveMode.activeTabTime = 0; // Reset active tab time
        productiveMode.lastActiveTimestamp = null; // Reset last active timestamp
        
        // If disabling productive mode, clear all blocked URLs
        if (!message.enabled) {
          blockedUrls = {};
          chrome.storage.local.set({ blockedUrls });
          console.log('Productive mode disabled, cleared all blocked URLs');
        }
        
        chrome.storage.local.set({ productiveMode });
        
        // Update icon based on current tab
        updateExtensionIcon(currentTab);
        
        sendResponse({ success: true });
        break;

      case 'manualOverrideChanged':
        // Handle manual override change
        if (message.url) {
          // Update the icon based on the override
          if (message.isProductive === true) {
            chrome.action.setIcon({
            path: {
              16: 'icons/green16.png',
              32: 'icons/green32.png',
              48: 'icons/green48.png',
              128: 'icons/green128.png',
            }
          });
          } else if (message.isProductive === false) {
            chrome.action.setIcon({
              path: {
                16: 'icons/red16.png',
                32: 'icons/red32.png',
                48: 'icons/red48.png',
                128: 'icons/red128.png',
              }
            });
          } else {
            // Override removed, revert to default icon based on current tab
            updateExtensionIcon(currentTab);
          }
          
          // If this is the current tab, update its data
          if (currentTab && currentTab.url === message.url) {
            // Force a recalculation of productivity state
            if (message.isProductive !== null) {
              currentTab.isProductive = message.isProductive;
            }
            // Update the current tab in storage
            chrome.storage.local.set({ currentTab });
          }
        }
        sendResponse({ success: true });
        break;
        
      case 'spaNavigation':
        const { url, title, content } = message;
        
        // Only process if this is a new URL we haven't analyzed yet
        if (url !== lastAnalyzedUrlWithHash) {
          lastAnalyzedUrlWithHash = url;
          
          // Update current tab with new info
          if (currentTab) {
            currentTab.url = url;
            currentTab.title = title;
            currentTab.isAnalyzing = true;
            chrome.storage.local.set({ currentTab });
            
            // Analyze with the extracted content
            analyzeContent(title, url, { content, siteName: extractDomain(url) }, true);
          }
        }
        
        sendResponse({ success: true });
        return true;
        
      default:
        console.warn(`Unknown message action: ${message.action}`);
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    sendResponse({ success: false, error: error.message });
  }
  
  return true; // Keep the message channel open for async response
}

/**
 * Update time tracking based on visibility and focus
 */
async function updateTimeTracking() {
  await maybeResetStatsDaily();
  // Track time if window is active and tab is visible
  // Even if analyzing, we'll track as non-productive
  if (isWindowActive && isTabVisible && currentTab && currentTab.domain) {
    const now = Date.now();
    
    // Check if it's a new tab (chrome://newtab/ or similar)
    const isNewTab = currentTab.url && (
      currentTab.url.startsWith('chrome://newtab') || 
      currentTab.url === 'about:blank' ||
      currentTab.url.startsWith('chrome://startpage')
    );
    
    // Don't track time for new tabs
    if (isNewTab) {
      return;
    }
    
    // Don't track time for blocked URLs or the blocked.html page
    if (currentTab.url && (
        blockedUrls[currentTab.url] || 
        currentTab.url.startsWith(chrome.runtime.getURL('blocked.html'))
      )) {
      return;
    }
    
    // If this is the first update after becoming visible/active
    if (!currentTab.lastUpdateTime) {
      currentTab.lastUpdateTime = now;
      chrome.storage.local.set({ currentTab });
      return;
    }
    
    // Calculate time since last update
    const timeSinceLastUpdate = now - currentTab.lastUpdateTime;
    
    // Only count if the time is reasonable (less than configured max gap)
    if (timeSinceLastUpdate > 0 && timeSinceLastUpdate < CONFIG.MAX_TIME_GAP) {
      // Initialize tracking for this domain if it doesn't exist
      if (!domainTracking[currentTab.domain]) {
        domainTracking[currentTab.domain] = {
          productiveTime: 0,
          nonProductiveTime: 0,
          productiveScore: 0,
          nonProductiveScore: 0
        };
      }
      
      // Initialize stats if needed
      if (!stats.productiveTime) stats.productiveTime = 0;
      if (!stats.nonProductiveTime) stats.nonProductiveTime = 0;
      if (!stats.domainVisits) stats.domainVisits = {};
      
      // Update domain-specific tracking based on current productivity state
      // If still analyzing, count as non-productive
      let isReallyProductive = !currentTab.isAnalyzing && currentTab.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
      
      // Check for manual override for the current URL
      let manualOverride = null;
      if (currentTab.url) {
        const overrides = (await chrome.storage.local.get('overrides')).overrides || {};
        if (overrides[currentTab.url] === true) manualOverride = true;
        if (overrides[currentTab.url] === false) manualOverride = false;
      }
      
      if (manualOverride === true) isReallyProductive = true;
      if (manualOverride === false) isReallyProductive = false;
      
      if (isReallyProductive) {
        domainTracking[currentTab.domain].productiveTime += timeSinceLastUpdate;
        domainTracking[currentTab.domain].productiveScore = currentTab.score;
        stats.productiveTime += timeSinceLastUpdate;
        console.log(`Added ${Math.round(timeSinceLastUpdate/1000)}s to productive time for ${currentTab.domain}`);
      } else {
        domainTracking[currentTab.domain].nonProductiveTime += timeSinceLastUpdate;
        domainTracking[currentTab.domain].nonProductiveScore = currentTab.isAnalyzing ? 0 : currentTab.score;
        stats.nonProductiveTime += timeSinceLastUpdate;
        console.log(`Added ${Math.round(timeSinceLastUpdate/1000)}s to non-productive time for ${currentTab.domain}`);
        // --- Per-URL timer logic ---
        if (productiveMode.enabled && !blockedUrls[currentTab.url]) {
          if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
          if (productiveMode.lastActiveTimestamp) {
            productiveMode.urlTimers[currentTab.url] = (productiveMode.urlTimers[currentTab.url] || 0) + (now - productiveMode.lastActiveTimestamp);
            productiveMode.activeTabTime = productiveMode.urlTimers[currentTab.url];
            productiveMode.lastActiveTimestamp = now;
            chrome.storage.local.set({ productiveMode });
          }
        }
        // ---
      }
      if (!stats.domainVisits[currentTab.domain]) {
        stats.domainVisits[currentTab.domain] = {
          domain: currentTab.domain,
          visits: 0,
          timeSpent: 0,
          isProductive: currentTab.isProductive,
          productivityScore: currentTab.score || 0,
          lastVisit: now
        };
      }
      stats.domainVisits[currentTab.domain].visits++;
      stats.domainVisits[currentTab.domain].lastVisit = now;
      stats.domainVisits[currentTab.domain].isProductive = currentTab.isProductive;
      stats.domainVisits[currentTab.domain].productivityScore = currentTab.score || 0;
      chrome.storage.local.set({ domainTracking, stats });
    } else if (timeSinceLastUpdate >= CONFIG.MAX_TIME_GAP) {
      console.log(`Time gap too large (${Math.round(timeSinceLastUpdate/1000)}s), resetting timer`);
    }
    
    // Update last update time
    currentTab.lastUpdateTime = now;
    chrome.storage.local.set({ currentTab });
    
    // Update the extension icon based on productivity status
    updateExtensionIcon(currentTab);
    
    // Check if productive mode is enabled and block unproductive content
    if (productiveMode.enabled) {
      let manualOverride = null;
      const overrides = (await chrome.storage.local.get('overrides')).overrides || {};
      if (currentTab.url) {
        if (overrides[currentTab.url] === true) manualOverride = true;
        if (overrides[currentTab.url] === false) manualOverride = false;
      }
      
      if (!currentTab.isProductive && currentTab.isProductive !== undefined && manualOverride !== true) {
        const now = Date.now();
        
        // Initialize or update the unproductive start time
        if (!productiveMode.unproductiveStartTime) {
          productiveMode.unproductiveStartTime = now;
          if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
          productiveMode.activeTabTime = productiveMode.urlTimers[currentTab.url] || 0;
          productiveMode.lastActiveTimestamp = now;
          chrome.storage.local.set({ productiveMode });
        } else {
          // Update the active tab time only if we're on the same tab
          if (productiveMode.lastActiveTimestamp) {
            const activeTimeSinceLastUpdate = now - productiveMode.lastActiveTimestamp;
            productiveMode.urlTimers[currentTab.url] = (productiveMode.urlTimers[currentTab.url] || 0) + activeTimeSinceLastUpdate;
            productiveMode.activeTabTime = productiveMode.urlTimers[currentTab.url];
            productiveMode.lastActiveTimestamp = now;
            chrome.storage.local.set({ productiveMode });
          }
        }
        
        // Only block if the user has been actively on this tab for 30 seconds
        if (productiveMode.activeTabTime > CONFIG.PRODUCTIVE_MODE_BLOCK_DELAY) {
          const blockedUrl = currentTab.url;
          const redirectUrl = `blocked.html?url=${encodeURIComponent(blockedUrl)}`;
          chrome.tabs.update(currentTab.id, { url: redirectUrl });
          blockedUrls[blockedUrl] = {
            timestamp: now,
            title: currentTab.title
          };
          chrome.storage.local.set({ blockedUrls });
          productiveMode.activeTabTime = 0;
          productiveMode.lastActiveTimestamp = null;
          productiveMode.unproductiveStartTime = null;
          productiveMode.urlTimers[blockedUrl] = 0;
          chrome.storage.local.set({ productiveMode });
        }
      } else {
        // Reset the unproductive start time if the content is productive or manually marked as productive
        productiveMode.unproductiveStartTime = null;
        productiveMode.activeTabTime = 0;
        productiveMode.lastActiveTimestamp = null;
        chrome.storage.local.set({ productiveMode });
      }
    }
  } else if (currentTab && currentTab.lastUpdateTime) {
    // If we're not tracking time but have a lastUpdateTime, reset it
    currentTab.lastUpdateTime = null;
    chrome.storage.local.set({ currentTab });
    
    // If we're in productive mode, pause the active tab timer
    if (productiveMode.enabled && productiveMode.unproductiveStartTime) {
      productiveMode.lastActiveTimestamp = null;
      chrome.storage.local.set({ productiveMode });
    }
  }
}

/**
 * Reset all statistics
 */
function resetStats() {
  stats = {
    productiveTime: 0,
    nonProductiveTime: 0,
    domainVisits: {},
    lastReset: Date.now(),
    analyzingDomains: {}
  };
  
  domainTracking = {};
  
  // Note: We don't clear the URL cache when resetting stats
  
  chrome.storage.local.set({ stats, domainTracking });
  console.log('Statistics reset');
}

/**
 * Daily stats reset logic
 */
async function maybeResetStatsDaily() {
  const today = getTodayString();
  if (statsResetDate !== today) {
    // Reset all stats
    stats = {
      productiveTime: 0,
      nonProductiveTime: 0,
      domainVisits: {},
      lastReset: Date.now(),
      analyzingDomains: {}
    };
    domainTracking = {};
    statsResetDate = today;
    await chrome.storage.local.set({ stats, domainTracking, statsResetDate });
    console.log('Daily stats reset');
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return url;
  }
}

/**
 * Update the extension icon based on the current tab productivity status
 */
function updateExtensionIcon(tab) {
  try {
    if (!tab) return;
    
    let iconPath = 'icons/prod.png'; // Default icon changed to prod.png
    let badgeText = '';
    let badgeColor = '#9e9e9e';
    
    // Check if this URL is already blocked
    const isBlocked = tab.url && blockedUrls[tab.url];
    
    // If in productive mode, show a special icon
    if (productiveMode.enabled) {
      if (isBlocked) {
        // For blocked URLs, show a red icon with ! badge
        iconPath = 'icons/red.png';
        badgeText = '!';
        badgeColor = '#f44336';
      } else if (tab.isProductive) {
        iconPath = 'icons/green.png';
        badgeText = '✓';
        badgeColor = '#4caf50';
      } else if (tab.isProductive === false) {
        iconPath = 'icons/red.png';
        
        // If we're tracking active time, show a countdown
        if (productiveMode.unproductiveStartTime && productiveMode.activeTabTime > 0) {
          const remainingTime = Math.max(0, Math.ceil((CONFIG.PRODUCTIVE_MODE_BLOCK_DELAY - productiveMode.activeTabTime) / 1000));
          badgeText = remainingTime.toString();
          badgeColor = '#f44336';
        } else {
          badgeText = '!';
          badgeColor = '#f44336';
        }
      } else {
        // Analyzing
        iconPath = 'icons/prod.png'; // Changed to prod.png
        badgeText = '?';
        badgeColor = '#2196f3';
      }
    } else {
      // Not in productive mode
      if (tab.isProductive) {
        iconPath = 'icons/green.png';
      } else if (tab.isProductive === false) {
        iconPath = 'icons/red.png';
      }
    }
    
    // Check for manual override
    chrome.storage.local.get(['overrides'], function(data) {
      const overrides = data.overrides || {};
      
      if (tab.url && overrides[tab.url] === true) {
        iconPath = 'icons/green.png';
        badgeText = 'M✓'; // M for manual
        badgeColor = '#4caf50';
      } else if (tab.url && overrides[tab.url] === false) {
        iconPath = 'icons/red.png';
        badgeText = 'M!'; // M for manual
        badgeColor = '#f44336';
      }
      
      // Set the icon
      // Set the icon for all required sizes
      chrome.action.setIcon({
        path: {
          16: iconPath.replace('.png', '16.png'),
          32: iconPath.replace('.png', '32.png'),
          48: iconPath.replace('.png', '48.png'),
          128: iconPath.replace('.png', '128.png'),
        }
      });
      
      // Set badge text and color
      chrome.action.setBadgeText({ text: badgeText });
      chrome.action.setBadgeBackgroundColor({ color: badgeColor });
    });
    
  } catch (error) {
    console.error('Error updating extension icon:', error);
  }
}

/**
 * Helper for date string (YYYY-MM-DD)
 */
function getTodayString() {
  const now = new Date();
  return now.getFullYear() + '-' + (now.getMonth()+1).toString().padStart(2,'0') + '-' + now.getDate().toString().padStart(2,'0');
}

// Set up content script for SPA monitoring
async function setupSPAContentScripts() {
  // Register content script for SPA sites
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: 'spa-monitor',
        matches: CONFIG.SPA_SITES.map(site => `*://*.${site}/*`),
        js: ['spa-monitor.js'],
        runAt: 'document_idle',
        world: 'MAIN'
      }
    ]);
    console.log('SPA monitor content script registered');
  } catch (error) {
    console.error('Error registering content script:', error);
    // If already registered, this is fine
    if (error.message.includes('already registered')) {
      console.log('SPA monitor content script already registered');
    }
  }
}

// Initialize the extension when loaded
init();
