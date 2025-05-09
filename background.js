/**
 * Background script for BattleTask - Focus Extension
 * 
 * This script:
 * 1. Communicates with the backend server for productivity content analysis
 * 2. Tracks tab activity and provides data to the popup
 */

// Platform detection (helps with platform-specific behavior)
const platformInfo = {
  isWindows: navigator.platform.indexOf('Win') !== -1,
  isMac: navigator.platform.indexOf('Mac') !== -1,
  isLinux: navigator.platform.indexOf('Linux') !== -1,
  isChromeOS: navigator.platform.indexOf('CrOS') !== -1
};

// Log platform for debugging
console.log('Platform detected:', platformInfo);

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
  CONTENT_LOAD_DELAY: platformInfo.isWindows ? 4000 : 2500, // Longer delay on Windows to ensure content loads
  STORAGE_RETRY_ATTEMPTS: 5, // Number of retry attempts for storage operations
  STORAGE_RETRY_DELAY: 200, // Base delay for storage retries (will be multiplied by attempt number)
  CACHE_CLEANUP_INTERVAL: 30 * 60 * 1000, // 30 minutes
  CACHE_WRITE_DEBOUNCE: 2000, // Debounce time for cache writes (ms)
  SPA_SITES: ['reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com', 'instagram.com', 'linkedin.com'],
  // Add always productive domains
  ALWAYS_PRODUCTIVE_DOMAINS: [
    'gmail.com',
    'outlook.com',
    'office.com',
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'jira.com',
    'confluence.com',
    'slack.com',
    'teams.microsoft.com',
    'zoom.us',
    'meet.google.com',
    'calendar.google.com',
    'docs.google.com',
    'drive.google.com',
    'sheets.google.com',
    'slides.google.com',
    'notion.so',
    'trello.com',
    'asana.com',
    'clickup.com',
    'monday.com',
    'figma.com',
    'adobe.com',
    'dropbox.com',
    'box.com',
    'onedrive.live.com',
    'sharepoint.com'
  ],
  // Add always non-productive domains
  ALWAYS_NON_PRODUCTIVE_DOMAINS: [
    'facebook.', 'twitter.', 'instagram.', 'tiktok.', 'pinterest.',
    'reddit.', 'tumblr.', 'snapchat.', 'whatsapp.',
    'youtube.', 'netflix.', 'hulu.', 'twitch.', 'vimeo.',
    'disneyplus.', 'primevideo.', 'hbomax.',
    'steam.', 'epicgames.', 'playstation.', 'xbox.', 'nintendo.',
    'roblox.', 'ea.com', 'blizzard.', 'ubisoft.', 'rockstargames.',
    'ign.', 'gamespot.', 'kotaku.', 'polygon.',
    'amazon.', 'ebay.', 'walmart.', 'target.', 'bestbuy.',
    'etsy.', 'wish.', 'aliexpress.', 'shein.', 'wayfair.',
    'cnn.', 'foxnews.', 'bbc.', 'nytimes.', 'washingtonpost.',
    'theguardian.', 'huffpost.', 'buzzfeed.', 'vice.'
  ]
};

// Cache Manager with Hash Map implementation
const CacheManager = {
  // Hash map for faster lookups
  urlHashMap: new Map(),
  
  // Initialize cache
  init: async function() {
    try {
      const data = await chrome.storage.local.get(['urlCache']);
      urlCache = data.urlCache || {};
      
      // Initialize hash map from cache
      Object.entries(urlCache).forEach(([url, data]) => {
        this.urlHashMap.set(url, data);
      });
      
      console.log('Cache initialized with', this.urlHashMap.size, 'entries');
      
      // Set up periodic cache cleanup
      setInterval(() => this.cleanCache(), 30 * 60 * 1000); // Clean every 30 minutes
    } catch (error) {
      console.error('Error initializing cache:', error);
      urlCache = {};
      this.urlHashMap.clear();
    }
  },
  
  // Add to cache
  addToCache: async function(url, data) {
    if (!url) return;
    
    try {
      const cacheEntry = {
        ...data,
        timestamp: Date.now(),
        platform: navigator.platform
      };
      
      // Update both cache and hash map
      urlCache[url] = cacheEntry;
      this.urlHashMap.set(url, cacheEntry);
      
      // Persist cache with retry mechanism
      await this.saveCacheWithRetry();
      console.log(`Added to cache: ${url}`);
    } catch (error) {
      console.error('Error adding to cache:', error);
    }
  },
  
  // Get from cache using hash map for O(1) lookup
  getFromCache: function(url) {
    if (!url) return null;
    
    // Check if URL is in always productive domains
    const domain = extractDomain(url);
    if (CONFIG.ALWAYS_PRODUCTIVE_DOMAINS.some(prodDomain => domain.includes(prodDomain))) {
      return {
        isProductive: true,
        score: 100,
        categories: ['Work Tool'],
        explanation: 'Automatically marked as productive (work tool)',
        timestamp: Date.now()
      };
    }
    
    // Use hash map for O(1) lookup
    const cachedData = this.urlHashMap.get(url);
    if (!cachedData) return null;
    
    const now = Date.now();
    
    // Check if cache is expired
    if (now - cachedData.timestamp > CONFIG.CACHE_EXPIRY) {
      this.urlHashMap.delete(url);
      delete urlCache[url];
      this.saveCacheWithRetry(); // Fire and forget
      return null;
    }
    
    console.log(`Cache hit for ${url}`);
    return cachedData;
  },
  
  // Save cache to storage with retry mechanism
  saveCacheWithRetry: async function(retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        await chrome.storage.local.set({ urlCache });
        return true;
      } catch (error) {
        console.error(`Cache save attempt ${i + 1} failed:`, error);
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (i + 1))); // Exponential backoff
      }
    }
    return false;
  },
  
  // Clean expired cache entries
  cleanCache: async function() {
    try {
      const now = Date.now();
      let cleanCount = 0;
      
      // Clean both cache and hash map
      for (const [url, data] of this.urlHashMap.entries()) {
        if (now - data.timestamp > CONFIG.CACHE_EXPIRY) {
          this.urlHashMap.delete(url);
          delete urlCache[url];
          cleanCount++;
        }
      }
      
      if (cleanCount > 0) {
        console.log(`Cleaned ${cleanCount} expired cache entries`);
        await this.saveCacheWithRetry();
      }
    } catch (error) {
      console.error('Error cleaning cache:', error);
    }
  }
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
  urlTimers: {}, // Map of url -> accumulated activeTabTime
  offlineMode: false
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

// Add analysis timer tracking to state
let analysisTimer = {
  startTime: null,
  url: null,
  accumulatedTime: 0
};

/**
 * Initialize the extension
 */
async function init() {
  console.log('BattleTask background initializing...', platformInfo);
  
  try {
    // Load saved stats and cache
    const data = await StorageUtil.get([
      'stats', 
      'domainTracking', 
      'urlCache', 
      'productiveMode', 
      'blockedUrls', 
      'userBlockedDomains', 
      'apiCallCount', 
      'apiCallDate', 
      'statsResetDate', 
      'settings'
    ]);
    
    if (data.stats) stats = data.stats;
    if (data.domainTracking) domainTracking = data.domainTracking;
    if (data.urlCache) urlCache = data.urlCache;
    if (data.productiveMode) {
      productiveMode = data.productiveMode;
      // Initialize offline mode if it doesn't exist
      if (productiveMode.offlineMode === undefined) {
        productiveMode.offlineMode = false;
      }
    }
    if (data.blockedUrls) blockedUrls = data.blockedUrls;
    if (data.userBlockedDomains) userBlockedDomains = data.userBlockedDomains;
    if (typeof data.apiCallCount === 'number') apiCallCount = data.apiCallCount;
    if (typeof data.apiCallDate === 'string') apiCallDate = data.apiCallDate;
    if (typeof data.statsResetDate === 'string') statsResetDate = data.statsResetDate;
    
    // Initialize settings if not present
    if (!data.settings) {
      await StorageUtil.set({
        settings: {
          theme: 'light', // Default theme
          transparentIcons: true, // Default to transparent icons
          localCategorization: true // Enable local categorization by default
        }
      });
    } else if (data.settings.localCategorization === undefined) {
      // Update settings to include localCategorization if it doesn't exist
      data.settings.localCategorization = true;
      await StorageUtil.set({ settings: data.settings });
    }
    
    // Initialize the Cache Manager
    await CacheManager.init();
    
    // Daily stats reset on startup
    await maybeResetStatsDaily();
    
    // Set up event listeners
    chrome.tabs.onActivated.addListener(handleTabActivated);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    chrome.runtime.onMessage.addListener(handleMessages);
    
    // Listen for changes to userBlockedDomains from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'userBlockedDomainsChanged') {
        userBlockedDomains = message.domains || [];
        StorageUtil.set({ userBlockedDomains });
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
  } catch (error) {
    console.error('Error initializing extension:', error);
  }
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
      StorageUtil.set({ productiveMode });
    }
    // ---
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) { return; }
    if (productiveMode.enabled && blockedUrls[tab.url]) {
      const redirectUrl = `blocked.html?url=${encodeURIComponent(tab.url)}`;
      chrome.tabs.update(tab.id, { url: redirectUrl });
      return;
    }
    
    const domain = extractDomain(tab.url);
    
    // Start analysis timer when activating a new tab
    const now = Date.now();
    analysisTimer = {
      startTime: now,
      url: tab.url,
      accumulatedTime: 0
    };
    
    // Check if URL is in cache before setting analysis state
    const cachedData = CacheManager.getFromCache(tab.url);
    
    currentTab = {
      id: tab.id,
      url: tab.url,
      domain: domain,
      title: tab.title,
      startTime: now,
      lastUpdateTime: null,
      isProductive: cachedData ? cachedData.isProductive : false,
      score: cachedData ? cachedData.score : 0,
      categories: cachedData ? cachedData.categories : [],
      explanation: cachedData ? cachedData.explanation : 'Analyzing...',
      lastUpdated: now,
      isAnalyzing: !cachedData // Only set to analyzing if not in cache
    };
    
    // If we found cached data, reset the analysis timer
    if (cachedData) {
      analysisTimer = {
        startTime: null,
        url: null,
        accumulatedTime: 0
      };
    }
    
    StorageUtil.set({ currentTab });
    // --- Resume timer for this non-productive tab ---
    if (productiveMode.enabled && !currentTab.isProductive && !blockedUrls[tab.url]) {
      productiveMode.unproductiveStartTime = Date.now();
      // Resume from stored time if exists
      if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
      productiveMode.activeTabTime = productiveMode.urlTimers[tab.url] || 0;
      productiveMode.lastActiveTimestamp = Date.now();
      StorageUtil.set({ productiveMode });
    }
    // ---
    
    // If we have cached data, use it and update the icon
    if (cachedData) {
      updateTabWithAnalysis(cachedData);
    } else {
      // Otherwise show the orange "analyzing" icon
      updateTabWithAnalysis({
        isProductive: false,
        score: 0,
        categories: [],
        explanation: 'Spend at least 5 seconds on the tab for analysis.',
        iconState: 'orange'
      });
    }
    
    updateExtensionIcon(currentTab);
  } catch (error) {
    console.error('Error in handleTabActivated:', error);
  }
}

/**
 * Handle tab updates, fired when tab is loaded or url changed
 */
async function handleTabUpdated(tabId, changeInfo, tab) {
  try {
    // Only process completed tab updates with a URL
    if (changeInfo.status !== 'complete' || !tab.url || tab.url === 'chrome://newtab/') {
      return;
    }
    
    // Only process the active tab in the current window
    const activeTabs = await chrome.tabs.query({active: true, currentWindow: true});
    if (activeTabs.length === 0 || activeTabs[0].id !== tabId) {
      return;
    }
    
    console.log('Tab updated:', tab.url);
    
    // Clear any previous analysis timeout
    if (currentTab && currentTab.analysisTimer) {
      clearTimeout(currentTab.analysisTimer);
    }
    
    // Check if URL has changed from the current tab
    if (currentTab && currentTab.url && currentTab.url !== tab.url) {
      // Reset analyzing state
      currentTab.isAnalyzing = false;
      
      // Update URL and reset the timer
      if (productiveMode.enabled) {
        // Save time for the previous URL
        if (currentTab.url && currentTab.isProductive !== null) {
          // In productive mode, we track time for URLs
          const elapsedTime = updateUrlTimer(currentTab.url, currentTab.isProductive);
          
          // Update domain tracking
          if (elapsedTime > 0) {
            const domain = extractDomain(currentTab.url);
            updateDomainTracking(domain, currentTab.isProductive, elapsedTime);
          }
        }
        
        // Reset timer for new URL
        productiveMode.lastActiveTimestamp = Date.now();
        productiveMode.urlTimers[tab.url] = productiveMode.urlTimers[tab.url] || 0;
        // Save the update to productiveMode in storage
        await StorageUtil.set({ productiveMode });
      }
    }
    
    // Get domain for URL for verification against block lists
    const domain = extractDomain(tab.url);
    
    // Check if this URL is blocked by user domains
    if (productiveMode.enabled && userBlockedDomains && userBlockedDomains.includes(domain)) {
      // Redirect to blocked page
      chrome.tabs.update(tabId, { url: chrome.runtime.getURL('blocked.html') });
      return;
    }
    
    // Check if this URL is in blocked URLs (exceeded time limit)
    if (productiveMode.enabled && blockedUrls[tab.url]) {
      // Redirect to blocked page
      chrome.tabs.update(tabId, { url: chrome.runtime.getURL('blocked.html') });
      return;
    }
    
    // Reset current tab
    if (currentTab.url !== tab.url) {
      currentTab = {
        tabId: tabId,
        url: tab.url,
        title: tab.title || '',
        isProductive: null, // Not analyzed yet
        score: null,
        categories: [],
        explanation: '',
        isAnalyzing: true, // Set analyzing state
        analysisTimer: null, // Will be set below
        lastUpdateTime: Date.now(),
        analysisStartTime: Date.now() // Track when we started analyzing
      };
    } else {
      // Only update title if it has changed
      if (tab.title && tab.title !== currentTab.title) {
        currentTab.title = tab.title;
      }
      currentTab.lastUpdateTime = Date.now();
    }
    
    // Set the timer to track how long the tab is being analyzed
    currentTab.analysisTimer = setTimeout(async () => {
      // After timeout, mark the tab as "analyzing complete"
      currentTab.isAnalyzing = false;
      // Store the update
      await StorageUtil.set({ currentTab });
    }, 2000); // 2 second timeout for analysis state
    
    // Update icon to reflect the current state (analyzing)
    await updateIcon(tabId, null, true);
    
    // Save current tab
    await StorageUtil.set({ currentTab });
    
    // For SPA sites, we need to wait a bit for content to load and extract more data
    if (CONFIG.SPA_SITES.some(site => tab.url.includes(site))) {
      console.log('SPA site detected, waiting for content to load...');
      
      // Use setTimeout to delay content script injection
      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        }).catch(error => {
          console.error('Error injecting content script:', error);
        });
      }, CONFIG.CONTENT_LOAD_DELAY);
    } else {
      // Start the title analysis with a slight delay to allow the tab to fully load
      setTimeout(() => {
        analyzeTabTitle(tab.title, tab.url);
      }, 500);
    }
    
    // If we have cached data for this URL, use it temporarily while waiting for fresh analysis
    try {
      const cachedData = CacheManager.getFromCache(tab.url);
      if (cachedData) {
        // Use cached data temporarily but mark that analysis is still in progress
        await updateTabWithAnalysis({ 
          ...cachedData, 
          isAnalyzing: true,
          isLocalAnalysis: true // Mark as local analysis since we're using cached data
        });
        
        // Apply a small delay before applying cached data
        setTimeout(() => {
          console.log('Applying cached data:', cachedData);
          // Now apply the cached data but stop the analyzing indicator
          updateTabWithAnalysis({ 
            ...cachedData, 
            isAnalyzing: false,
            isLocalAnalysis: true
          });
        }, 1000);
      }
    } catch (error) {
      console.error('Error retrieving from cache:', error);
    }
  } catch (error) {
    console.error('Error in handleTabUpdated:', error);
  }
}

/**
 * Update the timer for a URL and return the elapsed time
 * This function is used to track time spent on productive/non-productive sites
 * All time tracking logic is done locally for reliability
 */
function updateUrlTimer(url, isProductive) {
  try {
    // Skip empty URLs or null productivity values
    if (!url || isProductive === null) return 0;
    
    const now = Date.now();
    let elapsedTime = 0;
    
    // Calculate elapsed time if we have a previous timestamp
    if (productiveMode.lastActiveTimestamp) {
      const diff = now - productiveMode.lastActiveTimestamp;
      
      // Ignore suspiciously large time gaps (computer sleep, etc)
      if (diff > 0 && diff < CONFIG.MAX_TIME_GAP) {
        elapsedTime = diff;
        
        // Update the timers for this URL
        if (!productiveMode.urlTimers[url]) {
          productiveMode.urlTimers[url] = 0;
        }
        productiveMode.urlTimers[url] += elapsedTime;
        
        // Update the global productive/non-productive counters
        if (isProductive) {
          stats.productiveTime += elapsedTime;
        } else {
          stats.nonProductiveTime += elapsedTime;
        }
        
        // Log the update for debugging
        console.log(`Updated ${isProductive ? 'productive' : 'non-productive'} time for ${url}: +${elapsedTime}ms, total: ${productiveMode.urlTimers[url]}ms`);
        
        // Persist the updated stats to storage
        StorageUtil.set({ stats }).catch(error => {
          console.error('Error saving stats:', error);
        });
      } else if (diff >= CONFIG.MAX_TIME_GAP) {
        console.log(`Time gap too large (${diff}ms), ignoring`);
      }
    }
    
    // Update the timestamp for next calculation
    productiveMode.lastActiveTimestamp = now;
    
    // Save the updated productiveMode
    StorageUtil.set({ productiveMode }).catch(error => {
      console.error('Error saving productive mode data:', error);
    });
    
    return elapsedTime;
  } catch (error) {
    console.error('Error updating URL timer:', error);
    return 0;
  }
}

/**
 * Update domain tracking with time spent
 * This is used for analytics and reporting
 */
function updateDomainTracking(domain, isProductive, timeSpent) {
  try {
    if (!domain || timeSpent <= 0) return;
    
    // Initialize domain tracking if needed
    if (!domainTracking[domain]) {
      domainTracking[domain] = {
        productiveTime: 0,
        nonProductiveTime: 0,
        lastVisit: Date.now()
      };
    }
    
    // Update the appropriate counter
    if (isProductive) {
      domainTracking[domain].productiveTime += timeSpent;
    } else {
      domainTracking[domain].nonProductiveTime += timeSpent;
    }
    
    // Update last visit timestamp
    domainTracking[domain].lastVisit = Date.now();
    
    // Save domain tracking data
    StorageUtil.set({ domainTracking }).catch(error => {
      console.error('Error saving domain tracking:', error);
    });
    
    console.log(`Updated domain tracking for ${domain}: ${isProductive ? 'productive' : 'non-productive'} +${timeSpent}ms`);
  } catch (error) {
    console.error('Error updating domain tracking:', error);
  }
}

/**
 * Apply cached analysis results
 */
function applyUrlCache(url) {
  // Use the CacheManager to get cached data with better cross-platform support
  const cachedData = CacheManager.getFromCache(url);
  
  if (cachedData) {
    console.log(`Using cached data for ${url} from ${cachedData.platform || 'unknown platform'}`);
    
    // Update current tab with cached data
    currentTab.isAnalyzing = false;
    currentTab.isProductive = cachedData.isProductive;
    currentTab.score = cachedData.score;
    currentTab.categories = cachedData.categories || [];
    currentTab.explanation = cachedData.explanation || 'No explanation provided';
    currentTab.lastUpdated = Date.now();
    
    // Update the extension icon
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
  try {
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
    
    // Extract domain for always productive/non-productive checks
    const domain = extractDomain(url);
    
    // Check for always productive domains first - LOCAL check, no API call
    if (CONFIG.ALWAYS_PRODUCTIVE_DOMAINS.some(prodDomain => domain.includes(prodDomain))) {
      updateTabWithAnalysis({ 
        isProductive: true, 
        score: 100, 
        categories: ['Work Tool'], 
        explanation: 'Automatically marked as productive (work tool)',
        isLocalAnalysis: true // Flag to indicate local analysis
      });
      return;
    }
    
    // Check for always non-productive domains - LOCAL check, no API call
    if (CONFIG.ALWAYS_NON_PRODUCTIVE_DOMAINS.some(nonProdDomain => domain.includes(nonProdDomain))) {
      updateTabWithAnalysis({ 
        isProductive: false, 
        score: 0, 
        categories: ['Entertainment', 'Shopping', 'Gaming'], 
        explanation: 'Automatically marked as non-productive',
        isLocalAnalysis: true // Flag to indicate local analysis
      });
      return;
    }

    // Check for manual override first - LOCAL check, no API call
    const overrides = (await StorageUtil.get('overrides')).overrides || {};
    if (overrides[url] === true) {
      updateTabWithAnalysis({ 
        isProductive: true, 
        score: 100, 
        categories: ['Manual'], 
        explanation: 'User override: productive',
        isLocalAnalysis: true // Flag to indicate local analysis
      });
      return;
    }
    if (overrides[url] === false) {
      updateTabWithAnalysis({ 
        isProductive: false, 
        score: 0, 
        categories: ['Manual'], 
        explanation: 'User override: non-productive',
        isLocalAnalysis: true // Flag to indicate local analysis
      });
      return;
    }
    
    // Check cache before proceeding with analysis - LOCAL check, no API call
    const cachedData = CacheManager.getFromCache(url);
    if (cachedData && !force) {
      console.log('Using cached analysis for:', url);
      // Add the local analysis flag to cached data
      updateTabWithAnalysis({
        ...cachedData,
        isLocalAnalysis: true
      });
      return;
    }
    
    // If productive mode is enabled, prioritize local determination over API calls
    if (productiveMode.enabled) {
      // Check if there are any local signals to use before making API call
      
      // 1. Check user-blocked domains
      if (userBlockedDomains && userBlockedDomains.includes(domain)) {
        updateTabWithAnalysis({ 
          isProductive: false, 
          score: 0, 
          categories: ['User Blocked'], 
          explanation: 'Domain is in user-blocked list',
          isLocalAnalysis: true // Flag to indicate local analysis
        });
        return;
      }
      
      // 2. Apply any URL pattern-based rules
      // You could add URL pattern rules here if needed
      
      // 3. Use fallback local categorization for common domains
      // (This is a simplified heuristic approach, expand as needed)
      const localCategorization = getLocalDomainCategorization(domain);
      if (localCategorization) {
        updateTabWithAnalysis({
          ...localCategorization,
          isLocalAnalysis: true // Flag to indicate local analysis
        });
        return;
      }
    }

    // Rest of the existing code for API-based analysis
    // ... (Keep the original API code here)
    
    // Check if user spent at least 5 seconds on the tab
    if (!force && !currentTab.lastUpdateTime) {
      console.log('Not enough time spent on tab for analysis');
      return;
    }
    
    // API call rate limiting
    const today = getTodayString();
    if (apiCallDate !== today) {
      apiCallDate = today;
      apiCallCount = 0;
      await StorageUtil.set({ apiCallDate, apiCallCount });
    }
    
    // In productive mode, if we've reached the API limit, use local fallback categorization
    if (apiCallCount >= 300) {
      console.warn('API call limit reached for today (300). Using local categorization.');
      
      // Prioritize user preferences
      if (userBlockedDomains && userBlockedDomains.includes(domain)) {
        updateTabWithAnalysis({
          isProductive: false,
          score: 0,
          categories: ['User Blocked'],
          explanation: 'Domain is in user-blocked list. API limit reached.',
          isLocalAnalysis: true
        });
      } else {
        // If productive mode is enabled, we need to make a decision with local data
        if (productiveMode.enabled) {
          // Use a more conservative approach for productive mode
          const localResult = getLocalDomainCategorization(domain) || {
            isProductive: false, // Default to non-productive to be safe
            score: 40,
            categories: ['Local Fallback'],
            explanation: 'API limit reached. Using conservative local evaluation.'
          };
          
          updateTabWithAnalysis({
            ...localResult,
            isLocalAnalysis: true
          });
        } else {
          // For non-productive mode, we can be more lenient
          updateTabWithAnalysis({
            isProductive: true,
            score: CONFIG.PRODUCTIVITY_THRESHOLD,
            categories: ['API Limit'],
            explanation: 'API limit reached. Defaulting to productive since domain is not blocked by user.',
            isLocalAnalysis: true
          });
        }
      }
      return;
    }
    
    console.log('Analyzing title:', title);
    
    // Set up analysis timeout
    const analysisTimeout = setTimeout(() => {
      if (currentTab.isAnalyzing) {
        console.log(`Analysis timeout for ${url}`);
        
        // If in productive mode, use local categorization on timeout
        if (productiveMode.enabled) {
          const localResult = getLocalDomainCategorization(domain) || {
            isProductive: false, // Default to non-productive on timeout
            score: 30,
            categories: ['Timeout'],
            explanation: 'Analysis timed out. Using local evaluation.'
          };
          
          updateTabWithAnalysis({
            ...localResult,
            isLocalAnalysis: true
          });
        } else {
          updateTabWithAnalysis({
            isProductive: false,
            score: 0,
            categories: [],
            explanation: 'Analysis timed out',
            isLocalAnalysis: true
          });
        }
      }
    }, CONFIG.ANALYSIS_TIMEOUT);
    
    // Only make API calls if offline mode is not enabled
    if (productiveMode.offlineMode) {
      // If offline mode is enabled, use local categorization only
      clearTimeout(analysisTimeout);
      const localResult = getLocalDomainCategorization(domain) || {
        isProductive: false,
        score: 35,
        categories: ['Offline'],
        explanation: 'Offline mode enabled. Using local evaluation.'
      };
      
      updateTabWithAnalysis({
        ...localResult,
        isLocalAnalysis: true
      });
      return;
    }
    
    // Prepare request data
    const requestData = {
      title: title,
      url: url,
      domain: domain
    };
    
    // Increment API call count
    apiCallCount++;
    await StorageUtil.set({ apiCallCount, apiCallDate });
    
    try {
      // Send request to backend
      const response = await fetch(`${CONFIG.BACKEND_URL}/api/analyze-title`, {
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
      
      // Process analysis result
      if (!analysis.score && analysis.score !== 0) analysis.score = 0;
      if (typeof analysis.score === 'string') analysis.score = parseFloat(analysis.score);
      if (analysis.score <= 1 && analysis.score >= 0) analysis.score = Math.round(analysis.score * 100);
      else analysis.score = Math.min(100, Math.max(0, analysis.score));
      
      const isProductive = analysis.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
      
      // Cache the result using the improved CacheManager
      await CacheManager.addToCache(url, { 
        isProductive, 
        score: analysis.score, 
        categories: analysis.categories, 
        explanation: analysis.explanation
      });
      
      // Update tab data
      updateTabWithAnalysis({ 
        isProductive, 
        score: analysis.score, 
        categories: analysis.categories, 
        explanation: analysis.explanation
      });
    } catch (error) {
      // Handle network or server errors
      console.error('Error analyzing title:', error);
      
      // In productive mode, use local categorization on error
      if (productiveMode.enabled) {
        clearTimeout(analysisTimeout);
        const localResult = getLocalDomainCategorization(domain) || {
          isProductive: false, // Default to non-productive on error
          score: 20,
          categories: ['Error'],
          explanation: `Error analyzing content: ${error.message}. Using local evaluation.`
        };
        
        updateTabWithAnalysis({
          ...localResult,
          isLocalAnalysis: true
        });
      } else {
        // Set default values for error
        updateTabWithAnalysis({ 
          isProductive: false, 
          score: 0, 
          categories: [], 
          explanation: `Error analyzing content: ${error.message}`,
          isLocalAnalysis: true
        });
      }
    }
  } catch (error) {
    console.error('Error in analyzeTabTitle function:', error);
    
    // Set default values for error
    updateTabWithAnalysis({ 
      isProductive: false, 
      score: 0, 
      categories: [], 
      explanation: `Error analyzing content: ${error.message}`,
      isLocalAnalysis: true
    });
  }
}

/**
 * Helper function for local domain categorization
 * This provides a fallback when cloud services are unavailable
 */
function getLocalDomainCategorization(domain) {
  // Known productive domains by category (expand this list as needed)
  const knownProductiveDomains = {
    'education': [
      'coursera.org', 'edx.org', 'udemy.com', 'khanacademy.org', 'freecodecamp.org',
      'codecademy.com', 'pluralsight.com', 'skillshare.com', 'udacity.com', 'brilliant.org'
    ],
    'documentation': [
      'docs.', 'documentation.', 'developer.', 'api.', 'reference.'
    ],
    'work': [
      'slack.com', 'atlassian.', 'jira.', 'confluence.', 'asana.com',
      'trello.com', 'notion.so', 'miro.com', 'airtable.com', 'monday.com',
      'clickup.com', 'linear.app', 'figma.com', 'webex.', 'zoom.'
    ],
    'email': [
      'mail.', 'gmail.', 'outlook.', 'proton.', 'yahoo.mail'
    ],
    'coding': [
      'github.', 'gitlab.', 'bitbucket.', 'stackoverflow.', 'npmjs.',
      'pypi.', 'mvnrepository.', 'rubygems.', 'rust-lang.', 'jetbrains.',
      'vscode.', 'replit.', 'codesandbox.', 'codepen.'
    ],
    'office': [
      'office.', 'microsoft.', 'google.docs', 'sheets.', 'slides.',
      'drive.google.', 'onedrive.', 'sharepoint.'
    ]
  };
  
  // Known non-productive domains by category
  const knownNonProductiveDomains = {
    'social': [
      'facebook.', 'twitter.', 'instagram.', 'tiktok.', 'pinterest.',
      'reddit.', 'tumblr.', 'snapchat.', 'whatsapp.'
    ],
    'video': [
      'youtube.', 'netflix.', 'hulu.', 'twitch.', 'vimeo.',
      'disneyplus.', 'primevideo.', 'hbomax.'
    ],
    'gaming': [
      'steam.', 'epicgames.', 'playstation.', 'xbox.', 'nintendo.',
      'roblox.', 'ea.com', 'blizzard.', 'ubisoft.', 'rockstargames.',
      'ign.', 'gamespot.', 'kotaku.', 'polygon.'
    ],
    'shopping': [
      'amazon.', 'ebay.', 'walmart.', 'target.', 'bestbuy.',
      'etsy.', 'wish.', 'aliexpress.', 'shein.', 'wayfair.'
    ],
    'news': [
      'cnn.', 'foxnews.', 'bbc.', 'nytimes.', 'washingtonpost.',
      'theguardian.', 'huffpost.', 'buzzfeed.', 'vice.'
    ]
  };
  
  // Check if domain matches any known productive patterns
  for (const [category, domains] of Object.entries(knownProductiveDomains)) {
    if (domains.some(prod => domain.includes(prod))) {
      return {
        isProductive: true,
        score: 75, // Conservative score
        categories: [category.charAt(0).toUpperCase() + category.slice(1)],
        explanation: `Locally categorized as productive (${category})`
      };
    }
  }
  
  // Check if domain matches any known non-productive patterns
  for (const [category, domains] of Object.entries(knownNonProductiveDomains)) {
    if (domains.some(nonProd => domain.includes(nonProd))) {
      return {
        isProductive: false,
        score: 25, // Conservative score
        categories: [category.charAt(0).toUpperCase() + category.slice(1)],
        explanation: `Locally categorized as non-productive (${category})`
      };
    }
  }
  
  // If no matches were found, return null
  return null;
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
  
  // Check for manual override first
  const overrides = (await chrome.storage.local.get('overrides')).overrides || {};
  if (overrides[url] === true) {
    updateTabWithAnalysis({ isProductive: true, score: 100, categories: ['Manual'], explanation: 'User override: productive' });
    return;
  }
  if (overrides[url] === false) {
    updateTabWithAnalysis({ isProductive: false, score: 0, categories: ['Manual'], explanation: 'User override: non-productive' });
    return;
  }
  
  // Check cache before proceeding with analysis
  const cachedData = CacheManager.getFromCache(url);
  if (cachedData && !force) {
    console.log('Using cached analysis for:', url);
    updateTabWithAnalysis(cachedData);
    return;
  }
  
  // API call rate limiting
  const today = getTodayString();
  if (apiCallDate !== today) {
    apiCallDate = today;
    apiCallCount = 0;
    await chrome.storage.local.set({ apiCallDate, apiCallCount });
  }
  
  if (apiCallCount >= 300) {
    console.warn('API call limit reached for today (300). Analysis skipped.');
    updateTabWithAnalysis({ isProductive: false, score: 0, categories: [], explanation: 'Daily analysis limit reached. Try again tomorrow.' });
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
    await chrome.storage.local.set({ apiCallCount, apiCallDate });
    
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
    
    // Process analysis result
    if (!analysis.score && analysis.score !== 0) analysis.score = 0;
    if (typeof analysis.score === 'string') analysis.score = parseFloat(analysis.score);
    if (analysis.score <= 1 && analysis.score >= 0) analysis.score = Math.round(analysis.score * 100);
    else analysis.score = Math.min(100, Math.max(0, analysis.score));
    
    const isProductive = analysis.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
    
    // Cache the result using the improved CacheManager
    await CacheManager.addToCache(url, { 
      isProductive, 
      score: analysis.score, 
      categories: analysis.categories, 
      explanation: analysis.explanation
    });
    
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
  // Always set iconState to 'orange' if explanation is the <5s one
  if (analysisResult.explanation === 'Spend at least 5 seconds on the tab for analysis.' || analysisResult.iconState === 'orange') {
    currentTab.iconState = 'orange';
  } else {
    currentTab.iconState = analysisResult.iconState || null;
  }
  currentTab.lastUpdated = Date.now();
  
  // If we have accumulated analysis time, add it to the appropriate category
  if (analysisTimer.startTime && analysisTimer.url === currentTab.url) {
    const analysisTime = analysisTimer.accumulatedTime;
    if (analysisTime > 0) {
      if (currentTab.isProductive) {
        domainTracking[currentTab.domain].productiveTime += analysisTime;
        stats.productiveTime += analysisTime;
        console.log(`Added ${Math.round(analysisTime/1000)}s of analysis time to productive time for ${currentTab.domain}`);
      } else {
        domainTracking[currentTab.domain].nonProductiveTime += analysisTime;
        stats.nonProductiveTime += analysisTime;
        console.log(`Added ${Math.round(analysisTime/1000)}s of analysis time to non-productive time for ${currentTab.domain}`);
      }
    }
    // Reset analysis timer
    analysisTimer = {
      startTime: null,
      url: null,
      accumulatedTime: 0
    };
  }
  
  // Remove from analyzing domains
  if (stats.analyzingDomains[currentTab.domain]) {
    delete stats.analyzingDomains[currentTab.domain];
  }
  
  // Save current tab data
  chrome.storage.local.set({ currentTab, stats, domainTracking });
  
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
        
      case 'setOfflineMode':
        // Toggle offline mode (local categorization only)
        productiveMode.offlineMode = message.enabled;
        StorageUtil.set({ productiveMode }).catch(error => {
          console.error('Error saving offline mode setting:', error);
        });
        sendResponse({ success: true });
        break;
        
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
      // --- Trigger analysis ONLY after 5 seconds on tab ---
      let timeSpent = 0;
      if (domainTracking[currentTab.domain]) {
        timeSpent = domainTracking[currentTab.domain].productiveTime + domainTracking[currentTab.domain].nonProductiveTime;
      }
      
      // Platform-specific time threshold adjustment
      const timeThreshold = platformInfo.isWindows ? 4000 : 5000; // Slightly lower threshold on Windows
      
      // If not analyzed, not in cache, and just crossed threshold, trigger analysis
      if (
        timeSpent >= timeThreshold &&
        !currentTab.isAnalyzing &&
        (!CacheManager.getFromCache(currentTab.url) || currentTab.explanation === 'Spend at least 5 seconds on the tab for analysis.')
      ) {
        console.log(`Triggering analysis after ${timeSpent}ms on ${currentTab.url} (platform: ${navigator.platform})`);
        currentTab.isAnalyzing = true; // Set analyzing flag to prevent multiple analyses
        chrome.storage.local.set({ currentTab });
        
        // Start analysis timer
        analysisTimer = {
          startTime: now,
          url: currentTab.url,
          accumulatedTime: 0
        };
        
        // Determine if SPA or not
        const domain = currentTab.domain;
        const isSPA = CONFIG.SPA_SITES.some(site => domain.includes(site));
        
        try {
          if (isSPA) {
            // Use content extraction for SPA with better error handling
            chrome.scripting.executeScript({
              target: { tabId: currentTab.id },
              function: extractPageContent
            }, (results) => {
              if (chrome.runtime.lastError) {
                console.error('Error executing script:', chrome.runtime.lastError);
                // Fall back to title analysis on error
                analyzeTabTitle(currentTab.title, currentTab.url, true);
                return;
              }
              
              if (results && results[0] && results[0].result) {
                const content = results[0].result;
                analyzeContent(currentTab.title, currentTab.url, content, true);
              } else {
                analyzeTabTitle(currentTab.title, currentTab.url, true);
              }
            });
          } else {
            // Force analysis for better cross-platform consistency
            analyzeTabTitle(currentTab.title, currentTab.url, true);
          }
        } catch (error) {
          console.error('Error triggering analysis:', error);
          // Reset analyzing flag on error
          currentTab.isAnalyzing = false;
          chrome.storage.local.set({ currentTab });
        }
      }
      
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
      
      // If we're analyzing, only accumulate time in the analysis timer
      if (currentTab.isAnalyzing && analysisTimer.startTime && analysisTimer.url === currentTab.url) {
        analysisTimer.accumulatedTime += timeSinceLastUpdate;
        console.log(`Accumulated ${Math.round(timeSinceLastUpdate/1000)}s in analysis timer for ${currentTab.url}`);
      } else if (!currentTab.isAnalyzing) {
        // Only update categories if we're not analyzing
        let isReallyProductive = currentTab.score >= CONFIG.PRODUCTIVITY_THRESHOLD;
        
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
          domainTracking[currentTab.domain].nonProductiveScore = currentTab.score;
          stats.nonProductiveTime += timeSinceLastUpdate;
          console.log(`Added ${Math.round(timeSinceLastUpdate/1000)}s to non-productive time for ${currentTab.domain}`);
          
          // --- Per-URL timer logic for productive mode ---
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
      }
      
      // Update domain visits regardless of analysis state
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
    if (productiveMode.enabled && !currentTab.isAnalyzing) {
      let manualOverride = null;
      const overrides = (await chrome.storage.local.get('overrides')).overrides || {};
      if (currentTab.url) {
        if (overrides[currentTab.url] === true) manualOverride = true;
        if (overrides[currentTab.url] === false) manualOverride = false;
      }
      
      if (!currentTab.isProductive && currentTab.isProductive !== undefined && manualOverride !== true) {
        // Initialize or update the unproductive start time
        if (!productiveMode.unproductiveStartTime) {
          productiveMode.unproductiveStartTime = now;
          if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
          productiveMode.activeTabTime = productiveMode.urlTimers[currentTab.url] || 0;
          productiveMode.lastActiveTimestamp = now;
          chrome.storage.local.set({ productiveMode });
          console.log(`Started tracking unproductive time for ${currentTab.url}, current: ${productiveMode.activeTabTime}ms`);
        } else {
          // Update the active tab time only if we're on the same tab
          if (productiveMode.lastActiveTimestamp) {
            const activeTimeSinceLastUpdate = now - productiveMode.lastActiveTimestamp;
            productiveMode.urlTimers[currentTab.url] = (productiveMode.urlTimers[currentTab.url] || 0) + activeTimeSinceLastUpdate;
            productiveMode.activeTabTime = productiveMode.urlTimers[currentTab.url];
            productiveMode.lastActiveTimestamp = now;
            chrome.storage.local.set({ productiveMode });
            console.log(`Updated unproductive time for ${currentTab.url}: ${productiveMode.activeTabTime}ms`);
          }
        }
        
        // Only block if the user has been actively on this tab for 30 seconds
        if (productiveMode.activeTabTime > CONFIG.PRODUCTIVE_MODE_BLOCK_DELAY) {
          console.log(`Blocking unproductive URL after ${productiveMode.activeTabTime}ms: ${currentTab.url}`);
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
      // Always use orange icon if iconState is set to orange
      else if (tab.iconState === 'orange') {
        iconPath = 'icons/orange.png';
        badgeText = '!';
        badgeColor = '#ff9800';
      }
      
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

