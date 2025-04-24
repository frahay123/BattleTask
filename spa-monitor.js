/**
 * SPA Monitor Content Script
 * 
 * This script monitors single-page applications (SPAs) for navigation changes
 * that don't trigger traditional page loads, and notifies the extension
 * background script when content changes.
 */

(function() {
  // Store the last URL we've seen to detect changes
  let lastUrl = window.location.href;
  let lastTitle = document.title;
  
  // Function to extract page content
  function extractPageContent() {
    try {
      // Get the page title
      const pageTitle = document.title;
      
      // Get main content based on site
      let mainContent = '';
      
      // Reddit-specific extraction
      if (window.location.hostname.includes('reddit.com')) {
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
        // Get tweet text
        const tweetText = document.querySelector('[data-testid="tweetText"]')?.innerText || '';
        // Get profile name if on profile
        const profileName = document.querySelector('h2[aria-level="2"]')?.innerText || '';
        
        mainContent = `${tweetText} ${profileName}`;
      }
      
      // If we couldn't extract specific content, get general page content
      if (!mainContent) {
        // Get all headings
        const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 3).map(h => h.innerText).join(' ');
        // Get main content paragraphs
        const paragraphs = Array.from(document.querySelectorAll('p')).slice(0, 5).map(p => p.innerText).join(' ');
        
        mainContent = `${headings} ${paragraphs}`;
      }
      
      return mainContent.substring(0, 1000); // Limit content length
    } catch (e) {
      console.error('Error extracting page content:', e);
      return '';
    }
  }
  
  // Function to check for URL changes
  function checkForChanges() {
    const currentUrl = window.location.href;
    const currentTitle = document.title;
    
    // If the URL or title has changed
    if (currentUrl !== lastUrl || currentTitle !== lastTitle) {
      // Wait a moment for the page content to fully load
      setTimeout(() => {
        // Extract content
        const content = extractPageContent();
        
        // Notify the extension background script
        try {
          chrome.runtime.sendMessage({
            action: 'spaNavigation',
            url: currentUrl,
            title: currentTitle,
            content: content
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('Error sending message to extension:', chrome.runtime.lastError);
            }
          });
          
          // Update last seen URL and title
          lastUrl = currentUrl;
          lastTitle = currentTitle;
        } catch (e) {
          console.error('Error communicating with extension:', e);
        }
      }, 1500); // Wait 1.5 seconds for content to load
    }
  }
  
  // Set up history state change listener (for pushState/replaceState)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function() {
    originalPushState.apply(this, arguments);
    checkForChanges();
  };
  
  history.replaceState = function() {
    originalReplaceState.apply(this, arguments);
    checkForChanges();
  };
  
  // Listen for popstate events (back/forward navigation)
  window.addEventListener('popstate', function() {
    checkForChanges();
  });
  
  // Check periodically for changes that might not trigger history events
  setInterval(checkForChanges, 2000);
  
  // Initial check
  setTimeout(checkForChanges, 1000);
  
  console.log('BattleTask SPA monitor initialized');
})();
