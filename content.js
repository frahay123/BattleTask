/**
 * Content script for BattleTask Focus Extension
 * 
 * This script handles:
 * 1. Detecting fullscreen video
 * 2. Tracking active page time
 * 3. Sending activity data to background script
 * 4. Monitoring tab visibility
 */

let isFullscreen = false;
let lastActivityTime = Date.now();
let activityInterval = null;
let isPageActive = true;
let isVisible = true;

// Listen for fullscreen changes
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
document.addEventListener('MSFullscreenChange', handleFullscreenChange);

// Listen for user activity
document.addEventListener('mousemove', recordActivity);
document.addEventListener('keypress', recordActivity);
document.addEventListener('scroll', recordActivity);
document.addEventListener('click', recordActivity);

// Listen for visibility changes
document.addEventListener('visibilitychange', handleVisibilityChange);

// Initialize
init();

/**
 * Safely send a message to the background script
 * Handles extension context invalidation errors
 */
function safeSendMessage(message, callback) {
  try {
    // Check if extension context is valid
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          // Silently handle context invalidation or other errors
          console.warn('Extension context invalidated or message failed:', chrome.runtime.lastError.message);
          if (callback && typeof callback === 'function') callback(undefined);
        } else if (callback && typeof callback === 'function') {
          callback(response);
        }
      });
    } else {
      // Context is invalid, do not throw
      console.warn('Extension context invalidated, cannot send message');
      if (callback && typeof callback === 'function') callback(undefined);
    }
  } catch (error) {
    // Silently handle all errors
    console.warn('Error sending message to background script:', error);
    if (callback && typeof callback === 'function') callback(undefined);
  }
}

/**
 * Initialize the content script
 */
function init() {
  console.log('BattleTask content script initialized');
  
  // Start activity tracking
  activityInterval = setInterval(checkActivity, 5000);
  
  // Set initial visibility state
  isVisible = document.visibilityState === 'visible';
  
  // Notify the background script of initial visibility
  notifyVisibilityChange(isVisible);
  
  // Notify the background script that the page has loaded
  safeSendMessage({
    action: 'pageLoaded',
    url: window.location.href,
    title: document.title,
    isActive: true
  });
  
  // Handle unload
  window.addEventListener('beforeunload', () => {
    safeSendMessage({
      action: 'pageUnloaded',
      url: window.location.href
    });
  });
}

/**
 * Handle fullscreen changes
 */
function handleFullscreenChange() {
  const wasFullscreen = isFullscreen;
  isFullscreen = !!document.fullscreenElement || 
                 !!document.webkitFullscreenElement || 
                 !!document.mozFullScreenElement || 
                 !!document.msFullscreenElement;
  
  // Only send message if state has changed
  if (wasFullscreen !== isFullscreen) {
    console.log(`Fullscreen state changed: ${isFullscreen}`);
    
    // Check if it's a video element
    let videoFullscreen = false;
    let videoElement = null;
    
    if (isFullscreen) {
      videoElement = document.fullscreenElement || 
                     document.webkitFullscreenElement || 
                     document.mozFullScreenElement || 
                     document.msFullscreenElement;
      
      videoFullscreen = videoElement && videoElement.tagName === 'VIDEO';
    }
    
    // Send message to background script
    safeSendMessage({
      action: 'fullscreenChange',
      isFullscreen: isFullscreen,
      isVideoFullscreen: videoFullscreen,
      videoSrc: videoFullscreen && videoElement ? videoElement.src : null,
      url: window.location.href,
      title: document.title
    });
  }
}

/**
 * Record user activity
 */
function recordActivity() {
  lastActivityTime = Date.now();
  
  // If the page was inactive, notify that it's now active
  if (!isPageActive) {
    isPageActive = true;
    safeSendMessage({
      action: 'activityChange',
      isActive: true,
      url: window.location.href,
      title: document.title
    });
  }
}

/**
 * Check if the user is still active on the page
 */
function checkActivity() {
  const now = Date.now();
  const inactiveTime = now - lastActivityTime;
  
  // If inactive for more than 60 seconds, mark as inactive
  if (inactiveTime > 60000 && isPageActive) {
    isPageActive = false;
    safeSendMessage({
      action: 'activityChange',
      isActive: false,
      url: window.location.href,
      title: document.title
    });
  }
}

/**
 * Handle visibility changes (tab focus/blur)
 */
function handleVisibilityChange() {
  const wasVisible = isVisible;
  isVisible = document.visibilityState === 'visible';
  
  // Only send message if state has changed
  if (wasVisible !== isVisible) {
    console.log(`Visibility state changed: ${isVisible ? 'visible' : 'hidden'}`);
    notifyVisibilityChange(isVisible);
  }
}

/**
 * Notify the background script about visibility changes
 */
function notifyVisibilityChange(isVisible) {
  safeSendMessage({
    action: 'visibilityChange',
    isVisible: isVisible,
    url: window.location.href,
    title: document.title
  }, response => {
    if (response && response.success) {
      console.log(`Successfully notified background of visibility: ${isVisible}`);
    }
  });
}
