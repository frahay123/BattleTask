/**
 * Content script for ProductiveTime Extension
 * 
 * This script handles:
 * 1. Detecting fullscreen video
 * 2. Tracking active page time
 * 3. Sending activity data to background script
 */

let isFullscreen = false;
let lastActivityTime = Date.now();
let activityInterval = null;
let isPageActive = true;

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
 * Initialize the content script
 */
function init() {
  console.log('ProductiveTime content script initialized');
  
  // Start activity tracking
  activityInterval = setInterval(checkActivity, 5000);
  
  // Notify the background script that the page has loaded
  chrome.runtime.sendMessage({
    action: 'pageLoaded',
    url: window.location.href,
    title: document.title,
    isActive: true
  });
  
  // Handle unload
  window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({
      action: 'pageUnloaded',
      url: window.location.href,
      title: document.title
    });
  });
}

/**
 * Handle fullscreen changes
 */
function handleFullscreenChange() {
  const fullscreenElement = document.fullscreenElement || 
                           document.webkitFullscreenElement || 
                           document.mozFullScreenElement || 
                           document.msFullscreenElement;
  
  // Check if we're entering or exiting fullscreen
  const newFullscreenState = !!fullscreenElement;
  
  // Only send a message if the state has changed
  if (isFullscreen !== newFullscreenState) {
    isFullscreen = newFullscreenState;
    
    // Check if the fullscreen element is a video
    const isVideo = isFullscreen && (
      fullscreenElement.tagName === 'VIDEO' || 
      fullscreenElement.querySelector('video') !== null ||
      fullscreenElement.classList.contains('video-player') ||
      /video|player/i.test(fullscreenElement.id) ||
      /video|player/i.test(fullscreenElement.className)
    );
    
    // Send message to background script
    chrome.runtime.sendMessage({
      action: 'fullscreenChange',
      isFullscreen: isFullscreen,
      isVideo: isVideo,
      url: window.location.href,
      title: document.title
    });
    
    console.log(`Fullscreen ${isFullscreen ? 'entered' : 'exited'}, isVideo: ${isVideo}`);
  }
}

/**
 * Record user activity
 */
function recordActivity() {
  lastActivityTime = Date.now();
  
  // If the page was inactive, mark it as active again
  if (!isPageActive) {
    isPageActive = true;
    chrome.runtime.sendMessage({
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
  const inactiveTime = Date.now() - lastActivityTime;
  
  // If inactive for more than 30 seconds and currently marked as active
  if (inactiveTime > 30000 && isPageActive) {
    isPageActive = false;
    chrome.runtime.sendMessage({
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
  const isVisible = document.visibilityState === 'visible';
  
  chrome.runtime.sendMessage({
    action: 'visibilityChange',
    isVisible: isVisible,
    url: window.location.href,
    title: document.title
  });
  
  console.log(`Page visibility changed: ${isVisible ? 'visible' : 'hidden'}`);
  
  // If page becomes visible, record activity
  if (isVisible) {
    recordActivity();
  }
}
