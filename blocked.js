// blocked.js
// Handles blocked.html logic for BattleTask extension

// Get the URL of the blocked page from the URL parameter
const urlParams = new URLSearchParams(window.location.search);
let blockedUrl = urlParams.get('url') || '';

// If no URL parameter, try to get from referrer or localStorage
if (!blockedUrl) {
  blockedUrl = document.referrer;
  if (!blockedUrl) {
    blockedUrl = localStorage.getItem('lastBlockedUrl') || '';
  }
}

// Store the blocked URL in localStorage for reference
if (blockedUrl) {
  localStorage.setItem('lastBlockedUrl', blockedUrl);
  // Display the blocked URL
  const blockedUrlDisplay = document.getElementById('blockedUrlDisplay');
  if (blockedUrlDisplay) blockedUrlDisplay.textContent = blockedUrl;
}

// Prevent the user from going back to the blocked URL
history.pushState(null, null, document.URL);
window.addEventListener('popstate', function() {
  history.pushState(null, null, document.URL);
});
