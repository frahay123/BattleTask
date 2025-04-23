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
  MAX_TIME_GAP: 120000 // Allow up to 2 minutes between updates (handles suspension)
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

// --- SQL.js integration and daily reset for time tracking ---
import { loadSqlJs } from './sql.js';

// DB instance
let sqlDb = null;

// Initialize or load the SQLite DB from IndexedDB
async function initSqlDb() {
  const SQL = await loadSqlJs();
  let dbData = await new Promise(resolve => {
    const req = indexedDB.open('battletask-sqlite', 1);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      db.createObjectStore('sqlite', { keyPath: 'id' });
    };
    req.onsuccess = event => {
      const db = event.target.result;
      const tx = db.transaction('sqlite', 'readonly');
      const store = tx.objectStore('sqlite');
      const getReq = store.get('main');
      getReq.onsuccess = () => resolve(getReq.result ? getReq.result.data : null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
  sqlDb = new SQL.Database(dbData ? new Uint8Array(dbData) : undefined);
  // Create table if not exists
  sqlDb.run(`CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY,
    productiveTime INTEGER,
    nonProductiveTime INTEGER
  )`);
}

// Save SQLite DB to IndexedDB
async function persistSqlDb() {
  const dbData = sqlDb.export();
  await new Promise(resolve => {
    const req = indexedDB.open('battletask-sqlite', 1);
    req.onsuccess = event => {
      const db = event.target.result;
      const tx = db.transaction('sqlite', 'readwrite');
      const store = tx.objectStore('sqlite');
      store.put({ id: 'main', data: dbData });
      tx.oncomplete = resolve;
    };
    req.onerror = resolve;
  });
}

// Store today's stats in DB and reset counters
async function storeAndResetDailyStats() {
  if (!sqlDb) await initSqlDb();
  const today = new Date().toISOString().slice(0, 10);
  sqlDb.run('INSERT OR REPLACE INTO daily_stats (date, productiveTime, nonProductiveTime) VALUES (?, ?, ?)', [
    today,
    stats.productiveTime,
    stats.nonProductiveTime
  ]);
  await persistSqlDb();
  // Reset stats
  stats.productiveTime = 0;
  stats.nonProductiveTime = 0;
  stats.lastReset = Date.now();
  chrome.storage.local.set({ stats });
}

// Set up daily reset timer
function scheduleDailyReset() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = nextMidnight - now;
  setTimeout(() => {
    storeAndResetDailyStats().then(scheduleDailyReset);
  }, msUntilMidnight + 1000); // +1s buffer
}

// --- Startup catch-up: ensure daily reset always happens ---
async function catchUpDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  const lastResetDay = stats.lastReset
    ? new Date(stats.lastReset).toISOString().slice(0, 10)
    : null;
  if (lastResetDay !== today) {
    await storeAndResetDailyStats();
  }
}

// Call at extension startup
initSqlDb().then(async () => {
  await catchUpDailyReset();
  scheduleDailyReset();
});
// --- END SQL.js integration ---

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
  
  // Apply cached data to current tab
  currentTab.isProductive = cachedData.isProductive;
  currentTab.score = cachedData.score;
  currentTab.categories = cachedData.categories;
  currentTab.explanation = cachedData.explanation;
  currentTab.isAnalyzing = false;
  currentTab.startTime = Date.now();
  currentTab.lastUpdateTime = Date.now(); // Set this to start tracking time immediately
  
  // Remove this domain from analyzing list
  if (stats.analyzingDomains[currentTab.domain]) {
    delete stats.analyzingDomains[currentTab.domain];
  }
  
  // Save current tab data
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
        
        // Always analyze content for YouTube URLs to handle dynamic content like shorts
        if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
          // For YouTube, always analyze fresh content
          analyzeTabTitle(tab.title, tab.url);
        } else {
          // For other sites, check cache first
          if (urlCache[tab.url]) {
            applyUrlCache(tab.url);
          } else {
            // Analyze the new tab title
            analyzeTabTitle(tab.title, tab.url);
          }
        }
      }
    });
  }
  // If the tab title has changed but not the URL
  else if (changeInfo.title && currentTab.id === tabId && currentTab.url === tab.url) {
    currentTab.title = changeInfo.title;
    chrome.storage.local.set({ currentTab });
    
    const domain = extractDomain(tab.url);
    
    // Always re-analyze YouTube content when title changes (for shorts, videos, etc.)
    if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
      analyzeTabTitle(changeInfo.title, tab.url);
    } 
    // For other sites, only re-analyze if not in cache
    else if (!urlCache[tab.url]) {
      analyzeTabTitle(changeInfo.title, tab.url);
    }
  }
}

/**
 * Analyze tab title using backend server
 */
async function analyzeTabTitle(title, url) {
  try {
    // Set up analysis timeout
    const analysisTimeout = setTimeout(() => {
      // If analysis takes too long, mark as non-productive but stop analyzing
      if (currentTab.isAnalyzing) {
        console.log(`Analysis timeout for ${url}`);
        currentTab.isAnalyzing = false;
        currentTab.startTime = Date.now();
        currentTab.lastUpdateTime = Date.now();
        currentTab.isProductive = false;
        currentTab.score = 0;
        currentTab.explanation = "Analysis timed out";
        
        // Remove this domain from analyzing list
        if (stats.analyzingDomains[currentTab.domain]) {
          delete stats.analyzingDomains[currentTab.domain];
        }
        
        // Save current tab data
        chrome.storage.local.set({ currentTab, stats });
      }
    }, CONFIG.ANALYSIS_TIMEOUT);
    
    // Make request to backend server
    const response = await fetch(`${CONFIG.BACKEND_URL}/api/analyze-title`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title })
    });
    
    // Clear the timeout since we got a response
    clearTimeout(analysisTimeout);
    
    // Process response
    if (!response.ok) {
      throw new Error(`Backend server error: ${response.status}`);
    }

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
    
    // Update current tab with analysis results
    currentTab.isProductive = isProductive;
    currentTab.score = analysis.score;
    currentTab.categories = analysis.categories;
    currentTab.explanation = analysis.explanation;
    currentTab.isAnalyzing = false;
    currentTab.startTime = Date.now();
    currentTab.lastUpdateTime = Date.now(); // Set this to start tracking time immediately
    
    // Remove this domain from analyzing list
    if (stats.analyzingDomains[currentTab.domain]) {
      delete stats.analyzingDomains[currentTab.domain];
    }
    
    // Cache the analysis result
    urlCache[url] = {
      isProductive,
      score: analysis.score,
      categories: analysis.categories,
      explanation: analysis.explanation,
      timestamp: Date.now()
    };
    
    // Save the updated cache
    await chrome.storage.local.set({ currentTab, urlCache, stats });
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
      
    case 'analyzeYouTubeContent':
      // Special handler for YouTube content changes detected by youtube-observer.js
      console.log('YouTube content change detected:', message.title);
      
      // Update current tab with new URL and title
      if (currentTab && currentTab.domain && 
          (currentTab.domain.includes('youtube.com') || currentTab.domain.includes('youtu.be'))) {
        
        // Update the current tab data
        currentTab.url = message.url;
        currentTab.title = message.title;
        currentTab.isAnalyzing = true;
        currentTab.explanation = 'Analyzing...';
        currentTab.lastUpdated = Date.now();
        
        // Save updated state
        chrome.storage.local.set({ currentTab });
        
        // Immediately analyze the new content
        analyzeTabTitle(message.title, message.url);
      }
      
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
  // Track time if window is active and tab is visible
  // Even if analyzing, we'll track as non-productive
  if (isWindowActive && isTabVisible) {
    const now = Date.now();
    
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
      
      // Update domain-specific tracking based on current productivity state
      // If still analyzing, count as non-productive
      const isReallyProductive = !currentTab.isAnalyzing && currentTab.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
      
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
    } else if (timeSinceLastUpdate >= CONFIG.MAX_TIME_GAP) {
      // If the gap is too large, just update the timestamp without counting time
      console.log(`Time gap too large (${Math.round(timeSinceLastUpdate/1000)}s), resetting timer`);
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
