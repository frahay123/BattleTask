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
    // Entertainment and Social Media
    'tiktok.com',
    'instagram.com',
    'facebook.com',
    'twitter.com',
    'x.com',
    'reddit.com',
    'netflix.com',
    'hulu.com',
    'disneyplus.com',
    'twitch.tv',
    'youtube.com',
    'vimeo.com',
    'dailymotion.com',
    'snapchat.com',
    'pinterest.com',
    'tumblr.com',
    
    // Gaming
    'steam.com',
    'steampowered.com',
    'epicgames.com',
    'blizzard.com',
    'battle.net',
    'playstation.com',
    'xbox.com',
    'nintendo.com',
    'roblox.com',
    'ign.com',
    'gamespot.com',
    'polygon.com',
    'kotaku.com',
    'gamefaqs.com',
    'miniclip.com',
    'y8.com',
    'poki.com',
    'kongregate.com',
    'itch.io',
    'friv.com',
    'kizi.com',
    
    // E-commerce
    'amazon.com',
    'ebay.com',
    'walmart.com',
    'target.com',
    'bestbuy.com',
    'etsy.com',
    'wish.com',
    'aliexpress.com',
    'shein.com',
    'newegg.com',
    'wayfair.com',
    'shopify.com',
    'overstock.com',
    'homedepot.com',
    'lowes.com',
    'zappos.com',
    
    // Sports and Betting
    'espn.com',
    'bleacherreport.com',
    'draftkings.com',
    'fanduel.com',
    'bet365.com',
    'bovada.com',
    'sportsbook.com',
    'bettingsites.com',
    'sportsbetting.com'
  ]
};

// Storage lock to prevent race conditions
let storageOperationInProgress = false;
let storageQueue = [];
let cacheWriteTimer = null;
let lastCacheWrite = Date.now();

// Utilities for storage operations with lock
const StorageUtil = {
  // Set storage with locking mechanism
  set: async function(data) {
    return new Promise((resolve, reject) => {
      // Add operation to queue
      storageQueue.push({
        operation: 'set',
        data: data,
        resolve: resolve,
        reject: reject
      });
      
      // Process queue if not already in progress
      if (!storageOperationInProgress) {
        this._processQueue();
      }
    });
  },
  
  // Get storage with locking mechanism
  get: async function(keys) {
    return new Promise((resolve, reject) => {
      // Add operation to queue
      storageQueue.push({
        operation: 'get',
        keys: keys,
        resolve: resolve,
        reject: reject
      });
      
      // Process queue if not already in progress
      if (!storageOperationInProgress) {
        this._processQueue();
      }
    });
  },
  
  // Process storage operation queue
  _processQueue: async function() {
    if (storageQueue.length === 0) {
      storageOperationInProgress = false;
      return;
    }
    
    storageOperationInProgress = true;
    const item = storageQueue.shift();
    
    try {
      if (item.operation === 'set') {
        await this._setWithRetry(item.data);
        item.resolve();
      } else if (item.operation === 'get') {
        const result = await this._getWithRetry(item.keys);
        item.resolve(result);
      }
    } catch (error) {
      console.error(`Storage operation (${item.operation}) failed after multiple retries:`, error, {
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
      item.reject(error);
    }
    
    // Process next item in queue
    this._processQueue();
  },
  
  // Set with retry mechanism
  _setWithRetry: async function(data, attempt = 0) {
    const maxAttempts = CONFIG.STORAGE_RETRY_ATTEMPTS;
    
    try {
      await chrome.storage.local.set(data);
      console.debug(`Storage write success on attempt ${attempt + 1}`, {
        platform: navigator.platform,
        keys: Object.keys(data),
        timestamp: new Date().toISOString()
      });
      return true;
    } catch (error) {
      console.warn(`Storage write attempt ${attempt + 1} failed:`, error, {
        platform: navigator.platform,
        keys: Object.keys(data)
      });
      
      if (attempt < maxAttempts - 1) {
        // Exponential backoff with jitter
        const delay = CONFIG.STORAGE_RETRY_DELAY * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this._setWithRetry(data, attempt + 1);
      } else {
        throw error;
      }
    }
  },
  
  // Get with retry mechanism
  _getWithRetry: async function(keys, attempt = 0) {
    const maxAttempts = CONFIG.STORAGE_RETRY_ATTEMPTS;
    
    try {
      const result = await chrome.storage.local.get(keys);
      console.debug(`Storage read success on attempt ${attempt + 1}`, {
        platform: navigator.platform,
        keys: keys,
        timestamp: new Date().toISOString()
      });
      return result;
    } catch (error) {
      console.warn(`Storage read attempt ${attempt + 1} failed:`, error, {
        platform: navigator.platform,
        keys: keys
      });
      
      if (attempt < maxAttempts - 1) {
        // Exponential backoff with jitter
        const delay = CONFIG.STORAGE_RETRY_DELAY * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this._getWithRetry(keys, attempt + 1);
      } else {
        throw error;
      }
    }
  }
};

// Cache Manager with Hash Map implementation
const CacheManager = {
  // Hash map for faster lookups
  urlHashMap: new Map(),
  isInitialized: false,
  initPromise: null,
  
  // Initialize cache
  init: async function() {
    if (this.isInitialized) return;
    
    // If init is already in progress, return the promise
    if (this.initPromise) return this.initPromise;
    
    this.initPromise = new Promise(async (resolve, reject) => {
      try {
        console.log(`Initializing cache (platform: ${navigator.platform})`);
        
        const data = await StorageUtil.get(['urlCache']);
    urlCache = data.urlCache || {};
        
        // Clear the hash map before populating
        this.urlHashMap.clear();
        
        // Initialize hash map from cache
        let entryCount = 0;
        for (const [url, data] of Object.entries(urlCache)) {
          this.urlHashMap.set(url, data);
          entryCount++;
        }
        
        console.log(`Cache initialized with ${entryCount} entries (platform: ${navigator.platform})`);
        this.isInitialized = true;
    
    // Set up periodic cache cleanup
        this._setupCleanupInterval();
        
        resolve();
      } catch (error) {
        console.error('Error initializing cache:', error, {
          platform: navigator.platform,
          timestamp: new Date().toISOString()
        });
        // Set default values on error
        urlCache = {};
        this.urlHashMap.clear();
        this.isInitialized = true; // Mark as initialized even with empty cache to avoid repeated failures
        reject(error);
      } finally {
        this.initPromise = null;
      }
    });
    
    return this.initPromise;
  },
  
  // Set up cleanup interval
  _setupCleanupInterval: function() {
    // Clear any existing interval
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    
    // Create new interval
    this._cleanupInterval = setInterval(() => {
      console.log(`Running scheduled cache cleanup (platform: ${navigator.platform})`);
      this.cleanCache().catch(err => {
        console.error('Error in scheduled cache cleanup:', err, {
          platform: navigator.platform,
          timestamp: new Date().toISOString()
        });
      });
    }, CONFIG.CACHE_CLEANUP_INTERVAL);
    
    // Make sure interval doesn't prevent shutdown
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  },
  
  // Add to cache
  addToCache: async function(url, data) {
    if (!url) {
      console.warn('Attempted to cache with empty URL', {
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    // Normalize URL to avoid case sensitivity issues
    const normalizedUrl = this._normalizeUrl(url);
    
    try {
      await this.init(); // Ensure cache is initialized
      
      const cacheEntry = {
      ...data,
      timestamp: Date.now(),
        platform: navigator.platform
      };
      
      // Update both cache and hash map
      urlCache[normalizedUrl] = cacheEntry;
      this.urlHashMap.set(normalizedUrl, cacheEntry);
      
      // Debounce cache writes to avoid excessive writes
      this._debouncedSaveCache();
      
      console.log(`Added to cache: ${normalizedUrl} (platform: ${navigator.platform})`);
    } catch (error) {
      console.error('Error adding to cache:', error, {
        url: normalizedUrl,
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
    }
  },
  
  // Debounced save cache function
  _debouncedSaveCache: function() {
    // Clear existing timer
    if (cacheWriteTimer) {
      clearTimeout(cacheWriteTimer);
    }
    
    // Don't wait too long between saves
    const timeSinceLastWrite = Date.now() - lastCacheWrite;
    const delay = Math.min(
      CONFIG.CACHE_WRITE_DEBOUNCE, 
      Math.max(100, CONFIG.CACHE_WRITE_DEBOUNCE - timeSinceLastWrite)
    );
    
    // Set new timer
    cacheWriteTimer = setTimeout(() => {
      this.saveCacheWithRetry().catch(err => {
        console.error('Error in debounced cache save:', err, {
          platform: navigator.platform,
          timestamp: new Date().toISOString()
        });
      });
      lastCacheWrite = Date.now();
    }, delay);
  },
  
  // Get from cache using hash map for O(1) lookup
  getFromCache: function(url) {
    if (!url) return null;
    
    try {
      if (!this.isInitialized) {
        console.log("Cache not yet initialized when attempting lookup. Will initialize now.");
        // We'll try to initialize synchronously in this context
        // but won't wait for completion before checking the cache
        this.init().catch(err => {
          console.error('Error initializing cache during lookup:', err);
        });
      }
      
      // Normalize URL to avoid case sensitivity issues
      const normalizedUrl = this._normalizeUrl(url);
      
      // Check if URL is in always productive domains
      const domain = extractDomain(normalizedUrl);
      
      // Check for always productive domains
      if (CONFIG.ALWAYS_PRODUCTIVE_DOMAINS.some(prodDomain => domain.includes(prodDomain))) {
        return {
          isProductive: true,
          score: 100,
          categories: ['Work Tool'],
          explanation: 'Automatically marked as productive (work tool)',
          timestamp: Date.now()
        };
      }
      
      // Check for always non-productive domains
      if (CONFIG.ALWAYS_NON_PRODUCTIVE_DOMAINS.some(nonProdDomain => domain.includes(nonProdDomain))) {
        return {
          isProductive: false,
          score: 0,
          categories: ['Entertainment', 'Shopping', 'Gaming'],
          explanation: 'Automatically marked as non-productive',
          timestamp: Date.now()
        };
      }
      
      // Use hash map for O(1) lookup
      const cachedData = this.urlHashMap.get(normalizedUrl);
      if (!cachedData) return null;
      
      const now = Date.now();
      
      // Check if cache is expired
      if (now - cachedData.timestamp > CONFIG.CACHE_EXPIRY) {
        this.urlHashMap.delete(normalizedUrl);
        delete urlCache[normalizedUrl];
        this._debouncedSaveCache(); // Fire and forget
        return null;
      }
      
      console.log(`Cache hit for ${normalizedUrl} (platform: ${navigator.platform})`);
      return cachedData;
    } catch (error) {
      console.error('Error getting from cache:', error, {
        url: url,
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  },
  
  // Normalize URL to avoid case sensitivity issues
  _normalizeUrl: function(url) {
    try {
      // Extract the parts of the URL that we want to normalize
      const urlObj = new URL(url);
      
      // Convert hostname to lowercase
      const normalizedHostname = urlObj.hostname.toLowerCase();
      
      // Keep path, query and hash as-is for now
      // We could normalize path if needed
      
      // Reassemble the URL
      urlObj.hostname = normalizedHostname;
      return urlObj.toString();
    } catch (e) {
      // If URL parsing fails, just use the original
      console.warn(`URL normalization failed for ${url}:`, e);
      return url;
    }
  },
  
  // Save cache to storage with retry mechanism
  saveCacheWithRetry: async function(retries = CONFIG.STORAGE_RETRY_ATTEMPTS) {
    try {
      await StorageUtil.set({ urlCache });
      return true;
    } catch (error) {
      console.error('Final cache save failure after retries:', error, {
        platform: navigator.platform,
        timestamp: new Date().toISOString(),
        cacheSize: Object.keys(urlCache).length
      });
      return false;
    }
  },
  
  // Clean expired cache entries
  cleanCache: async function() {
    try {
      await this.init(); // Ensure cache is initialized
      
    const now = Date.now();
    let cleanCount = 0;
    
      // Track metrics
      const cacheSize = this.urlHashMap.size;
      
      // Clean both cache and hash map
      const expiredUrls = [];
      
      for (const [url, data] of this.urlHashMap.entries()) {
        if (now - data.timestamp > CONFIG.CACHE_EXPIRY) {
          this.urlHashMap.delete(url);
          expiredUrls.push(url);
        cleanCount++;
      }
      }
      
      // Remove from urlCache
      for (const url of expiredUrls) {
        delete urlCache[url];
      }
    
    if (cleanCount > 0) {
        console.log(`Cleaned ${cleanCount} expired cache entries (${((cleanCount/cacheSize)*100).toFixed(1)}% of cache)`, {
          platform: navigator.platform,
          timestamp: new Date().toISOString(),
          newCacheSize: this.urlHashMap.size
        });
        await this.saveCacheWithRetry();
      } else {
        console.log('Cache cleanup completed - no expired entries found', {
          platform: navigator.platform,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('Error cleaning cache:', error, {
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
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
  if (data.productiveMode) productiveMode = data.productiveMode;
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
          transparentIcons: true // Default to transparent icons
        }
      });
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
        StorageUtil.set({ userBlockedDomains }).catch(error => {
          console.error('Error saving userBlockedDomains:', error);
        });
    }
      return true; // Keep the message channel open for async response
  });
  
  // Set up visibility change listeners
  setupVisibilityTracking();
  
  // Start periodic updates for time tracking
    setInterval(() => { 
      updateTimeTracking().catch(error => {
        console.error('Error in updateTimeTracking:', error);
      });
    }, CONFIG.UPDATE_INTERVAL);
  
  // Get the current active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    await handleTabActivated({ tabId: tabs[0].id });
  }
  
  // Set up content script for SPA monitoring
    await setupSPAContentScripts();
    
    // Apply theme-appropriate styles for the extension
    await applyThemeStyles();
    
    console.log('BattleTask background initialized successfully');
  } catch (error) {
    console.error('Error during extension initialization:', error, {
      platform: navigator.platform,
      timestamp: new Date().toISOString()
    });
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
    
    // Start analysis timer when activating a new tab
    const now = Date.now();
    analysisTimer = {
      startTime: now,
      url: tab.url,
      accumulatedTime: 0
    };
    
    // Check if URL is in cache before setting analysis state
    const cachedData = CacheManager.getFromCache(tab.url);
    
    // Always create a new currentTab object to avoid any state carryover issues
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
      isAnalyzing: !cachedData, // Only set to analyzing if not in cache
      iconState: !cachedData ? 'orange' : null // Set iconState to orange for new tabs
    };
    
    // If we found cached data, reset the analysis timer
    if (cachedData) {
      analysisTimer = {
        startTime: null,
        url: null,
        accumulatedTime: 0
      };
    }
    
    chrome.storage.local.set({ currentTab });
    
    // --- Reset productive mode timers for the new tab ---
    if (productiveMode.enabled) {
      // For non-productive tabs, initialize the timer
      if (!cachedData || !cachedData.isProductive) {
      if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
      productiveMode.activeTabTime = productiveMode.urlTimers[tab.url] || 0;
        productiveMode.lastActiveTimestamp = !cachedData ? null : now; // Only start timer if analysis is already done
        productiveMode.unproductiveStartTime = !cachedData ? null : now;
      } else {
        // Reset timers for productive tabs
        productiveMode.activeTabTime = 0;
        productiveMode.lastActiveTimestamp = null;
        productiveMode.unproductiveStartTime = null;
      }
      chrome.storage.local.set({ productiveMode });
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
 * Handle tab updates (URL changes within a tab)
 */
async function handleTabUpdated(tabId, changeInfo, tab) {
  try {
    // Only process if this is the active tab and the URL changed
    if (!changeInfo.url || !tab.active) {
      return;
    }
    
    console.log(`Tab updated: ${changeInfo.url} on platform: ${navigator.platform}`);
    
    // Start analysis timer when URL changes
    const now = Date.now();
    analysisTimer = {
      startTime: now,
      url: changeInfo.url,
      accumulatedTime: 0
    };
    
    // Check if this URL is already blocked in productive mode
    if (productiveMode.enabled && blockedUrls[changeInfo.url]) {
      console.log(`Preventing navigation to blocked URL: ${changeInfo.url}`);
      
      // Create a redirect URL with the blocked URL as a parameter
      const redirectUrl = `blocked.html?url=${encodeURIComponent(changeInfo.url)}`;
      
      // Redirect to the blocked page
      chrome.tabs.update(tabId, { url: redirectUrl });
      return;
    }
    
    // Check if we have this URL in cache
    const cachedData = CacheManager.getFromCache(changeInfo.url);
    
    // If we found cached data, reset the analysis timer
    if (cachedData) {
      console.log(`Using cached data for tab update: ${changeInfo.url}`);
      analysisTimer = {
        startTime: null,
        url: null,
        accumulatedTime: 0
      };
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
    
    // Update current tab with a fresh object to avoid state carryover
    currentTab = {
      id: tab.id,
      url: tab.url,
      domain: domain,
      title: tab.title || '',
      startTime: now,
      lastUpdateTime: null, // Will be set on first update
      isProductive: cachedData ? cachedData.isProductive : false,
      score: cachedData ? cachedData.score : 0,
      categories: cachedData ? cachedData.categories : [],
      explanation: cachedData ? cachedData.explanation : 'Analyzing...',
      lastUpdated: now,
      isAnalyzing: !cachedData, // Only set to analyzing if not in cache
      iconState: !cachedData ? 'orange' : null // Set iconState to orange for new pages
    };
    
    // Save current tab
    await chrome.storage.local.set({ currentTab });
    
    // --- Reset productive mode timers for URL change ---
    if (productiveMode.enabled) {
      // For non-productive tabs, initialize the timer
      if (!cachedData || !cachedData.isProductive) {
        if (!productiveMode.urlTimers) productiveMode.urlTimers = {};
        productiveMode.activeTabTime = productiveMode.urlTimers[tab.url] || 0;
        productiveMode.lastActiveTimestamp = !cachedData ? null : now; // Only start timer if analysis is already done
        productiveMode.unproductiveStartTime = !cachedData ? null : now;
      } else {
        // Reset timers for productive tabs
        productiveMode.activeTabTime = 0;
        productiveMode.lastActiveTimestamp = null;
        productiveMode.unproductiveStartTime = null;
      }
      chrome.storage.local.set({ productiveMode });
    }
    // ---
    
    // For SPA sites, we need to wait a bit for content to load and extract more data
    const isSPA = CONFIG.SPA_SITES.some(site => domain.includes(site));
    
    // Track the full URL with hash for SPAs
    const urlWithHash = tab.url;
    
    // If URL has cached data, apply it immediately
    if (cachedData) {
      updateTabWithAnalysis(cachedData);
    } else {
      // Otherwise show the orange "analyzing" indicator
    updateTabWithAnalysis({
      isProductive: false,
      score: 0,
      categories: [],
      explanation: 'Spend at least 5 seconds on the tab for analysis.',
      iconState: 'orange'
    });
    }
  } catch (error) {
    console.error('Error in handleTabUpdated:', error);
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
    
    // Check for always productive domains first
    if (CONFIG.ALWAYS_PRODUCTIVE_DOMAINS.some(prodDomain => domain.includes(prodDomain))) {
      updateTabWithAnalysis({ 
        isProductive: true, 
        score: 100, 
        categories: ['Work Tool'], 
        explanation: 'Automatically marked as productive (work tool)' 
      });
      return;
    }
    
    // Check for always non-productive domains
    if (CONFIG.ALWAYS_NON_PRODUCTIVE_DOMAINS.some(nonProdDomain => domain.includes(nonProdDomain))) {
      updateTabWithAnalysis({ 
        isProductive: false, 
        score: 0, 
        categories: ['Entertainment', 'Shopping', 'Gaming'], 
        explanation: 'Automatically marked as non-productive' 
      });
      return;
    }

    // Check for manual override first
    const overrides = (await StorageUtil.get('overrides')).overrides || {};
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
    
    // Rest of the existing analyzeTabTitle code
    // ...

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
    
    console.log('Analyzing title:', title);
    
    // Set up analysis timeout
    const analysisTimeout = setTimeout(() => {
      if (currentTab.isAnalyzing) {
        console.log(`Analysis timeout for ${url}`);
        updateTabWithAnalysis({ isProductive: false, score: 0, categories: [], explanation: 'Analysis timed out' });
      }
    }, CONFIG.ANALYSIS_TIMEOUT);
    
    // Prepare request data
    const requestData = {
      title: title,
      url: url,
      domain: domain
    };
    
    // Increment API call count
    apiCallCount++;
    await StorageUtil.set({ apiCallCount, apiCallDate });
    
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
  
  // Extract domain for always productive/non-productive checks
  const domain = extractDomain(url);
  
  // Check for always productive domains first
  if (CONFIG.ALWAYS_PRODUCTIVE_DOMAINS.some(prodDomain => domain.includes(prodDomain))) {
    updateTabWithAnalysis({ 
      isProductive: true, 
      score: 100, 
      categories: ['Work Tool'], 
      explanation: 'Automatically marked as productive (work tool)' 
    });
    return;
  }
  
  // Check for always non-productive domains
  if (CONFIG.ALWAYS_NON_PRODUCTIVE_DOMAINS.some(nonProdDomain => domain.includes(nonProdDomain))) {
    updateTabWithAnalysis({ 
      isProductive: false, 
      score: 0, 
      categories: ['Entertainment', 'Shopping', 'Gaming'], 
      explanation: 'Automatically marked as non-productive' 
    });
    return;
  }
  
  // Check for manual override first
  const overrides = (await StorageUtil.get('overrides')).overrides || {};
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
    await StorageUtil.set({ apiCallDate, apiCallCount });
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
    const requestData = {
      title: title,
      content: extractedContent.content || '',
      siteName: extractedContent.siteName || '',
      url: url,
      domain: domain
    };
    
    // Increment API call count
    apiCallCount++;
    await StorageUtil.set({ apiCallDate, apiCallCount });
    
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
          
          // Apply theme-appropriate styles
          applyThemeStyles();
        });
        sendResponse({ success: true });
        break;
      
      case 'setTransparentIcons':
        // Set transparent icons preference
        chrome.storage.local.get(['settings'], function(data) {
          const settings = data.settings || {};
          settings.transparentIcons = message.enabled;
          chrome.storage.local.set({ settings });
          
          // Apply theme-appropriate styles
          applyThemeStyles();
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
async function resetStats() {
  stats = {
    productiveTime: 0,
    nonProductiveTime: 0,
    domainVisits: {},
    lastReset: Date.now(),
    analyzingDomains: {}
  };
  
  domainTracking = {};
  
  // Note: We don't clear the URL cache when resetting stats
  
  try {
    await StorageUtil.set({ stats, domainTracking });
    console.log('Statistics reset successfully');
  } catch (error) {
    console.error('Error resetting stats:', error, {
      platform: navigator.platform,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Daily stats reset logic
 */
async function maybeResetStatsDaily() {
  const today = getTodayString();
  if (statsResetDate !== today) {
    try {
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
      
      await StorageUtil.set({ stats, domainTracking, statsResetDate });
      console.log('Daily stats reset successfully', {
        date: today,
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error during daily stats reset:', error, {
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      });
    }
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
      } else if (tab.isAnalyzing) {
        // Show orange icon with ? badge for analyzing state
        iconPath = 'icons/orange.png';
        badgeText = '?';
        badgeColor = '#ff9800';
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
        // Default for unknown state
        iconPath = 'icons/prod.png'; // Changed to prod.png
        badgeText = '?';
        badgeColor = '#2196f3';
      }
    } else {
      // Not in productive mode
      if (tab.isAnalyzing) {
        iconPath = 'icons/orange.png';
        badgeText = '?';
        badgeColor = '#ff9800';
      } else if (tab.isProductive) {
        iconPath = 'icons/green.png';
      } else if (tab.isProductive === false) {
        iconPath = 'icons/red.png';
      }
    }
    
    // Check for manual override
    chrome.storage.local.get(['overrides', 'settings'], function(data) {
      const overrides = data.overrides || {};
      const settings = data.settings || {};
      const isDarkMode = settings.theme === 'dark';
      
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
        badgeText = '?';
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
      
      // Apply dark mode-friendly style to the badge
      if (isDarkMode) {
        chrome.action.setBadgeTextColor({ color: '#ffffff' });
        // We can't change the icon background but we can adjust badge text color
      }
    });
    
  } catch (error) {
    console.error('Error updating extension icon:', error, {
      platform: navigator.platform,
      timestamp: new Date().toISOString()
    });
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

/**
 * Apply theme-appropriate styles for the extension
 */
async function applyThemeStyles() {
  try {
    const data = await StorageUtil.get(['settings']);
    const settings = data.settings || { theme: 'light', transparentIcons: true };
    
    if (settings.theme === 'dark') {
      // In dark mode, we make sure text is visible
      chrome.action.setBadgeTextColor({ color: '#ffffff' });
    } else {
      // In light mode, we use default text color
      chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
    
    // We'll also update the current tab icon to reflect theme changes
    if (currentTab) {
      updateExtensionIcon(currentTab);
    }
  } catch (error) {
    console.error('Error applying theme styles:', error, {
      platform: navigator.platform,
      timestamp: new Date().toISOString()
    });
  }
}

// Initialize the extension when loaded
init().catch(error => {
  console.error('Failed to initialize extension:', error, {
    platform: navigator.platform,
    timestamp: new Date().toISOString()
  });
});

