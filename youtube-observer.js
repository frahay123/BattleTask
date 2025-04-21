/**
 * YouTube-specific content observer to detect video changes
 * This script detects YouTube video changes that might not trigger normal navigation events
 */

console.log('YouTube observer initialized');

// Function to safely send messages to background script
function safeSendMessage(message, callback) {
  try {
    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage(message, response => {
        if (callback) callback(response);
      });
    } else {
      console.warn('Extension context invalidated, cannot send message');
    }
  } catch (error) {
    console.warn('Error sending message to background script:', error);
  }
}

// Track the current video ID and title
let currentVideoId = '';
let currentVideoTitle = '';

// Function to extract video ID from YouTube URL
function getYouTubeVideoId(url) {
  const urlObj = new URL(url);
  // Handle regular YouTube video URLs
  if (urlObj.pathname === '/watch') {
    return urlObj.searchParams.get('v');
  }
  // Handle YouTube Shorts URLs
  else if (urlObj.pathname.startsWith('/shorts/')) {
    return urlObj.pathname.split('/')[2];
  }
  return null;
}

// Function to get the current video title
function getVideoTitle() {
  // For regular videos
  let title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent;
  
  // For shorts
  if (!title) {
    title = document.querySelector('ytd-reel-player-header-renderer h2')?.textContent;
  }
  
  return title || document.title;
}

// Function to check for video changes
function checkForVideoChanges() {
  // Get current URL and video ID
  const url = window.location.href;
  const videoId = getYouTubeVideoId(url);
  const videoTitle = getVideoTitle();
  
  // If video ID or title has changed, notify the background script
  if ((videoId && videoId !== currentVideoId) || 
      (videoTitle && videoTitle !== currentVideoTitle)) {
    
    console.log(`YouTube video changed: ${videoTitle}`);
    
    // Update current video tracking
    currentVideoId = videoId;
    currentVideoTitle = videoTitle;
    
    // Notify background script to re-analyze
    safeSendMessage({
      action: 'analyzeYouTubeContent',
      url: url,
      title: videoTitle
    });
  }
}

// Set up a MutationObserver to detect DOM changes
const observer = new MutationObserver(function(mutations) {
  // Debounce the check to avoid too many calls
  clearTimeout(window.ytCheckTimeout);
  window.ytCheckTimeout = setTimeout(checkForVideoChanges, 500);
});

// Start observing the document with the configured parameters
observer.observe(document.body, { 
  childList: true, 
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'href', 'title']
});

// Initial check when script loads
checkForVideoChanges();

// Also check periodically (as a fallback)
setInterval(checkForVideoChanges, 2000);

// Check when URL changes via History API
const originalPushState = history.pushState;
history.pushState = function() {
  originalPushState.apply(this, arguments);
  checkForVideoChanges();
};

const originalReplaceState = history.replaceState;
history.replaceState = function() {
  originalReplaceState.apply(this, arguments);
  checkForVideoChanges();
};

// Check when page visibility changes
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) {
    checkForVideoChanges();
  }
});
