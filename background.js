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
  PRODUCTIVITY_THRESHOLD: 0.5, // Threshold for determining if content is productive
  CACHE_EXPIRY: 7 * 24 * 60 * 60 * 1000 // Cache expiry time (7 days in milliseconds)
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
  analyzingDomains: {} // Track domains that are currently being analyzed
};

// Domain-specific tracking
let domainTracking = {};

// URL analysis cache
let urlCache = {};

// Visibility tracking
let isWindowActive = false;
let isTabVisible = false;
let lastActiveTime = null;

// Initialize the extension
async function init() {
  console.log('BattleTask background initializing...');
  
  // Load saved stats and cache
  const data = await chrome.storage.local.get(['stats', 'domainTracking', 'urlCache']);
  if (data.stats) stats = data.stats;
  if (data.domainTracking) domainTracking = data.domainTracking;
  if (data.urlCache) urlCache = data.urlCache;
  
  // Initialize analyzingDomains if it doesn't exist
  if (!stats.analyzingDomains) {
    stats.analyzingDomains = {};
  }
  
  // Clean expired cache entries
  cleanExpiredCache();
  
  // Set up event listeners for tab changes
  chrome.tabs.onActivated.addListener(handleTabActivated);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  
  // Set up message listeners
  chrome.runtime.onMessage.addListener(handleMessages);
  
  // Set up visibility change listeners
  setupVisibilityTracking();
  
  // Start periodic updates for time tracking
  setInterval(updateTimeTracking, CONFIG.UPDATE_INTERVAL);
  
  // Get the current active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    await handleTabActivated({ tabId: tabs[0].id });
  }
  
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
  });
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
    // Get tab details
    const tab = await chrome.tabs.get(activeInfo.tabId);
    
    // Skip chrome:// urls and extension pages
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }
    
    // Set current tab data
    const domain = extractDomain(tab.url);
    currentTab = {
      id: tab.id,
      url: tab.url,
      domain: domain,
      title: tab.title || '',
      startTime: null, // Will be set after analysis
      lastUpdateTime: null,
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Analyzing...',
      lastUpdated: Date.now(),
      isAnalyzing: true
    };
    
    // Mark this domain as being analyzed
    stats.analyzingDomains[domain] = true;
    
    // Save current tab data
    await chrome.storage.local.set({ currentTab, stats });
    
    // Reset tab visibility state for the new tab
    isTabVisible = true;
    
    // Check if URL is in cache before analyzing
    if (urlCache[tab.url]) {
      applyUrlCache(tab.url);
    } else {
      // Analyze the tab's productivity
      analyzeTabTitle(tab.title, tab.url);
    }
    
    console.log(`Tab activated: ${domain} - ${tab.title}`);
  } catch (error) {
    console.error('Error handling tab activation:', error);
  }
}

/**
 * Apply cached analysis results
 */
function applyUrlCache(url) {
  const cachedData = urlCache[url];
  if (!cachedData) return;
  
  console.log(`Using cached analysis for ${url}`);
  
  const domain = extractDomain(url);
  
  // Update current tab with cached analysis results
  currentTab.isProductive = cachedData.isProductive;
  currentTab.score = cachedData.score;
  currentTab.categories = cachedData.categories || [];
  currentTab.explanation = cachedData.explanation || 'Cached result';
  currentTab.isAnalyzing = false;
  currentTab.lastUpdateTime = Date.now();
  currentTab.lastUpdated = Date.now();
  
  // Remove from analyzing domains
  delete stats.analyzingDomains[domain];
  
  // Save updated state
  chrome.storage.local.set({ currentTab, stats });
}

/**
 * Handle tab updates (URL changes within a tab)
 */
function handleTabUpdated(tabId, changeInfo, tab) {
  // Only proceed if the URL has changed
  if (changeInfo.url) {
    // Skip chrome:// urls and extension pages
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }
    
    console.log(`URL changed: ${tab.url}`);
    
    // Check if this is the current active tab
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length > 0 && tabs[0].id === tabId) {
        // Update current tab data
        const domain = extractDomain(tab.url);
        currentTab = {
          id: tab.id,
          url: tab.url,
          domain: domain,
          title: tab.title || '',
          startTime: null, // Will be set after analysis
          lastUpdateTime: null,
          isProductive: false,
          score: 0,
          categories: [],
          explanation: 'Analyzing...',
          lastUpdated: Date.now(),
          isAnalyzing: true
        };
        
        // Mark this domain as being analyzed
        stats.analyzingDomains[domain] = true;
        
        // Save current tab data
        await chrome.storage.local.set({ currentTab, stats });
        
        // Check if URL is in cache before analyzing
        if (urlCache[tab.url]) {
          applyUrlCache(tab.url);
        } else {
          // Analyze the new tab title
          analyzeTabTitle(tab.title, tab.url);
        }
      }
    });
  }
  // If the tab title has changed but not the URL
  else if (changeInfo.title && currentTab.id === tabId && currentTab.url === tab.url) {
    currentTab.title = changeInfo.title;
    chrome.storage.local.set({ currentTab });
    
    // Only re-analyze if the URL is not in cache
    if (!urlCache[tab.url]) {
      analyzeTabTitle(changeInfo.title, tab.url);
    }
  }
}

/**
 * Analyze tab title using backend server
 */
async function analyzeTabTitle(title, url) {
  try {
    const domain = extractDomain(url);
    
    if (!title || title.trim() === '' || title === 'New Tab') {
      currentTab.isProductive = false;
      currentTab.score = 0;
      currentTab.categories = [];
      currentTab.explanation = 'Empty or new tab';
      currentTab.lastUpdated = Date.now();
      currentTab.isAnalyzing = false;
      currentTab.lastUpdateTime = Date.now();
      
      // Remove from analyzing domains
      delete stats.analyzingDomains[domain];
      
      await chrome.storage.local.set({ currentTab, stats });
      return;
    }

    // Mark as analyzing
    currentTab.isAnalyzing = true;
    stats.analyzingDomains[domain] = true;
    await chrome.storage.local.set({ currentTab, stats });

    // Call the backend API
    const response = await fetch(`${CONFIG.BACKEND_URL}/api/analyze-title`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title })
    });

    if (!response.ok) {
      throw new Error(`Backend server error: ${response.status}`);
    }

    const analysis = await response.json();
    
    // Determine if the content is productive based on the score threshold
    const isProductive = analysis.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
    
    // Update current tab with analysis results
    currentTab.isProductive = isProductive;
    currentTab.score = analysis.score;
    currentTab.categories = analysis.categories;
    currentTab.explanation = analysis.explanation;
    currentTab.isAnalyzing = false;
    currentTab.lastUpdateTime = Date.now();
    currentTab.lastUpdated = Date.now();
    
    // Remove from analyzing domains
    delete stats.analyzingDomains[domain];
    
    // Cache the analysis result
    urlCache[url] = {
      isProductive,
      score: analysis.score,
      categories: analysis.categories,
      explanation: analysis.explanation,
      timestamp: Date.now()
    };
    
    // Save the updated cache
    await chrome.storage.local.set({ currentTab, stats, urlCache });
    return analysis;
  } catch (error) {
    console.error('Error analyzing title:', error);
    currentTab.explanation = `Error: ${error.message}`;
    currentTab.lastUpdated = Date.now();
    currentTab.isAnalyzing = false;
    
    // Remove from analyzing domains in case of error
    delete stats.analyzingDomains[extractDomain(url)];
    
    await chrome.storage.local.set({ currentTab, stats });
  }
}

/**
 * Handle messages from popup
 */
function handleMessages(message, sender, sendResponse) {
  switch (message.action) {
    case 'getCurrentTab':
      sendResponse({ success: true, data: currentTab });
      break;
      
    case 'getStats':
      // Calculate productive percentage
      const totalTime = stats.productiveTime + stats.nonProductiveTime;
      const productivePercentage = totalTime > 0 ? 
        Math.round((stats.productiveTime / totalTime) * 100) : 0;
      
      // Get domain distribution
      const productiveDomains = [];
      const nonProductiveDomains = [];
      
      // Process all domains through domain tracking
      Object.entries(domainTracking).forEach(([domain, tracking]) => {
        // Skip domains that are currently being analyzed
        if (stats.analyzingDomains[domain]) {
          return;
        }
        
        // Add to productive domains if it has productive time
        if (tracking.productiveTime > 0) {
          productiveDomains.push({
            domain: domain,
            timeSpent: tracking.productiveTime,
            isProductive: true,
            score: tracking.productiveScore || 0,
            totalTimeSpent: tracking.productiveTime + tracking.nonProductiveTime,
            productivePercentage: Math.round((tracking.productiveTime / (tracking.productiveTime + tracking.nonProductiveTime)) * 100)
          });
        }
        
        // Add to non-productive domains if it has non-productive time
        if (tracking.nonProductiveTime > 0) {
          nonProductiveDomains.push({
            domain: domain,
            timeSpent: tracking.nonProductiveTime,
            isProductive: false,
            score: tracking.nonProductiveScore || 0,
            totalTimeSpent: tracking.productiveTime + tracking.nonProductiveTime,
            productivePercentage: Math.round((tracking.productiveTime / (tracking.productiveTime + tracking.nonProductiveTime)) * 100)
          });
        }
      });
      
      // Add domains that are not in domain tracking (for backward compatibility)
      Object.values(stats.domainVisits).forEach(domain => {
        // Skip domains that are currently being analyzed
        if (stats.analyzingDomains[domain.domain]) {
          return;
        }
        
        // Skip domains that are already handled by domain tracking
        if (domainTracking[domain.domain]) {
          return;
        }
        
        // For domains not in domain tracking, add them to the appropriate list
        if (domain.isProductive) {
          productiveDomains.push({
            ...domain,
            totalTimeSpent: domain.timeSpent,
            productivePercentage: 100
          });
        } else {
          nonProductiveDomains.push({
            ...domain,
            totalTimeSpent: domain.timeSpent,
            productivePercentage: 0
          });
        }
      });
      
      // Sort domains by time spent
      productiveDomains.sort((a, b) => b.timeSpent - a.timeSpent);
      nonProductiveDomains.sort((a, b) => b.timeSpent - a.timeSpent);
      
      // Add distribution data to stats
      const statsWithDistribution = {
        ...stats,
        productivePercentage,
        productiveDomains: productiveDomains.slice(0, 5),
        nonProductiveDomains: nonProductiveDomains.slice(0, 5),
        domainTracking,
        cacheSize: Object.keys(urlCache).length,
        isWindowActive,
        isTabVisible
      };
      
      sendResponse({ success: true, data: statsWithDistribution });
      break;
      
    case 'resetStats':
      resetStats();
      sendResponse({ success: true });
      break;
      
    case 'clearCache':
      urlCache = {};
      chrome.storage.local.set({ urlCache });
      sendResponse({ success: true, message: 'Cache cleared' });
      break;
      
    case 'setTheme':
      // Store theme preference
      chrome.storage.local.set({ 
        settings: { theme: message.theme } 
      });
      sendResponse({ success: true });
      break;
      
    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
  
  return true; // Keep the message channel open for async responses
}

/**
 * Update time tracking based on visibility and focus
 */
function updateTimeTracking() {
  // Only track time if not analyzing, window is active, and tab is visible
  if (!currentTab.isAnalyzing && isWindowActive && isTabVisible) {
    const now = Date.now();
    
    // If this is the first update after becoming visible/active
    if (!currentTab.lastUpdateTime) {
      currentTab.lastUpdateTime = now;
      chrome.storage.local.set({ currentTab });
      return;
    }
    
    // Calculate time since last update
    const timeSinceLastUpdate = now - currentTab.lastUpdateTime;
    
    // Only count if the time is reasonable (less than 30 seconds)
    if (timeSinceLastUpdate > 0 && timeSinceLastUpdate < 30000) {
      // Initialize tracking for this domain if it doesn't exist
      if (!domainTracking[currentTab.domain]) {
        domainTracking[currentTab.domain] = {
          productiveTime: 0,
          nonProductiveTime: 0,
          productiveScore: 0,
          nonProductiveScore: 0
        };
      }
      
      // Update domain-specific tracking based on current productivity state
      if (currentTab.isProductive) {
        domainTracking[currentTab.domain].productiveTime += timeSinceLastUpdate;
        domainTracking[currentTab.domain].productiveScore = currentTab.score;
        stats.productiveTime += timeSinceLastUpdate;
        console.log(`Added ${Math.round(timeSinceLastUpdate/1000)}s to productive time for ${currentTab.domain}`);
      } else {
        domainTracking[currentTab.domain].nonProductiveTime += timeSinceLastUpdate;
        domainTracking[currentTab.domain].nonProductiveScore = currentTab.score;
        stats.nonProductiveTime += timeSinceLastUpdate;
        console.log(`Added ${Math.round(timeSinceLastUpdate/1000)}s to non-productive time for ${currentTab.domain}`);
      }
      
      // Update domain stats for backward compatibility
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
      
      // Save tracking and stats
      chrome.storage.local.set({ domainTracking, stats });
    }
    
    // Update last update time
    currentTab.lastUpdateTime = now;
    chrome.storage.local.set({ currentTab });
  } else if (currentTab.lastUpdateTime) {
    // If we're not tracking time but have a lastUpdateTime, reset it
    currentTab.lastUpdateTime = null;
    chrome.storage.local.set({ currentTab });
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

// Initialize the extension when loaded
init();
