/**
 * BattleTask Extension Popup
 * 
 * This script handles the popup UI for the BattleTask productivity extension.
 * It displays current site status, productivity statistics, and domain breakdowns.
 */

document.addEventListener('DOMContentLoaded', function() {
  // DOM Elements
  const siteUrl = document.getElementById('site-url');
  const statusIndicator = document.getElementById('status-indicator');
  const productivityStatus = document.getElementById('productivity-status');
  const productivityScore = document.getElementById('productivity-score');
  const statusReason = document.getElementById('status-reason');
  const toggleDetails = document.getElementById('toggle-details');
  const productiveTime = document.getElementById('productive-time');
  const nonProductiveTime = document.getElementById('non-productive-time');
  const productivityPercentage = document.getElementById('productivity-percentage');
  const progressBar = document.getElementById('progress-bar');
  const productiveDomainList = document.getElementById('productive-domain-list');
  const nonProductiveDomainList = document.getElementById('non-productive-domain-list');
  const resetStatsButton = document.getElementById('reset-stats');
  const clearCacheButton = document.getElementById('clear-cache');
  const cacheInfo = document.getElementById('cache-info');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const productiveModeToggle = document.getElementById('productive-mode-toggle');
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const currentSiteCard = document.getElementById('current-site-card');
  const overrideSection = document.getElementById('manual-override-section');
  const overrideUrlSpan = document.getElementById('override-url');
  const markProductiveBtn = document.getElementById('mark-productive-btn');
  const markNonProductiveBtn = document.getElementById('mark-nonproductive-btn');
  const removeOverrideBtn = document.getElementById('remove-override-btn');
  const overrideStatusDiv = document.getElementById('override-status');
  const blockDomainInput = document.getElementById('block-domain-input');
  const addBlockDomainBtn = document.getElementById('add-block-domain-btn');
  const blockedDomainsList = document.getElementById('blocked-domains-list');
  let currentUrl = '';

  // Initialize UI
  initializeUI();

  /**
   * Initialize the UI components and load data
   */
  function initializeUI() {
    // Load theme preference
    loadThemePreference();
    
    // Load productive mode state
    loadProductiveModeState();
    
    // Set up event listeners
    setupEventListeners();
    
    // Load current tab data
    getCurrentTabData();
    
    // Load statistics
    loadStatistics();
    
    // Set up tab switching
    setupTabs();
    
    // Load user blocked domains
    loadBlockedDomains();
  }

  /**
   * Set up event listeners for interactive elements
   */
  function setupEventListeners() {
    // Toggle details button
    toggleDetails.addEventListener('click', function() {
      statusReason.classList.toggle('expanded');
      toggleDetails.textContent = statusReason.classList.contains('expanded') ? 'Hide Details' : 'Show Details';
    });
    
    // Reset stats button
    resetStatsButton.addEventListener('click', function() {
      if (confirm('Are you sure you want to reset all statistics? This cannot be undone.')) {
        chrome.runtime.sendMessage({ action: 'resetStats' }, function() {
          loadStatistics();
        });
      }
    });
    
    // Clear cache button
    clearCacheButton.addEventListener('click', function() {
      if (confirm('Are you sure you want to clear the URL analysis cache? This will cause all sites to be re-analyzed when you visit them next.')) {
        chrome.runtime.sendMessage({ action: 'clearCache' }, function() {
          loadStatistics();
        });
      }
    });
    
    // Theme toggle button
    themeToggleBtn.addEventListener('click', function() {
      const isDark = document.body.classList.contains('dark-theme');
      setTheme(!isDark);
      chrome.runtime.sendMessage({ 
        action: 'setTheme', 
        theme: !isDark ? 'dark' : 'light' 
      });
    });
    
    // Productive Mode toggle
    productiveModeToggle.addEventListener('change', function() {
      const isEnabled = this.checked;
      
      // Update productive mode state in storage
      chrome.storage.local.get(['productiveMode'], function(data) {
        const productiveMode = data.productiveMode || { enabled: false, unproductiveStartTime: null };
        productiveMode.enabled = isEnabled;
        productiveMode.unproductiveStartTime = null; // Reset timer when toggling
        
        chrome.storage.local.set({ productiveMode }, function() {
          console.log(`Productive mode ${isEnabled ? 'enabled' : 'disabled'}`);
          
          // Notify background script to update icon and start monitoring
          chrome.runtime.sendMessage({ 
            action: 'setProductiveMode', 
            enabled: isEnabled 
          });
        });
      });
    });
    
    markProductiveBtn.onclick = () => {
      chrome.storage.local.get(['overrides'], (data) => {
        const overrides = data.overrides || {};
        overrides[currentUrl] = true;
        chrome.storage.local.set({ overrides }, () => {
          showOverrideUI({ url: currentUrl });
          // Notify background script to update the icon
          chrome.runtime.sendMessage({ 
            action: 'manualOverrideChanged', 
            url: currentUrl,
            isProductive: true
          });
        });
      });
    };
    markNonProductiveBtn.onclick = () => {
      chrome.storage.local.get(['overrides'], (data) => {
        const overrides = data.overrides || {};
        overrides[currentUrl] = false;
        chrome.storage.local.set({ overrides }, () => {
          showOverrideUI({ url: currentUrl });
          // Notify background script to update the icon
          chrome.runtime.sendMessage({ 
            action: 'manualOverrideChanged', 
            url: currentUrl,
            isProductive: false
          });
        });
      });
    };
    removeOverrideBtn.onclick = () => {
      chrome.storage.local.get(['overrides'], (data) => {
        const overrides = data.overrides || {};
        delete overrides[currentUrl];
        chrome.storage.local.set({ overrides }, () => {
          showOverrideUI({ url: currentUrl });
          // Notify background script to update the icon
          chrome.runtime.sendMessage({ 
            action: 'manualOverrideChanged', 
            url: currentUrl,
            isProductive: null
          });
        });
      });
    };
    
    addBlockDomainBtn.onclick = () => {
      const val = blockDomainInput.value.trim().toLowerCase();
      if (!val) return;
      chrome.storage.local.get(['userBlockedDomains'], (data) => {
        let userBlockedDomains = data.userBlockedDomains || [];
        if (!userBlockedDomains.includes(val)) {
          userBlockedDomains.push(val);
          chrome.storage.local.set({ userBlockedDomains }, () => {
            blockDomainInput.value = '';
            renderBlockedDomains(userBlockedDomains);
            // Notify background to update enforcement
            chrome.runtime.sendMessage({ action: 'userBlockedDomainsChanged', domains: userBlockedDomains });
          });
        } else {
          blockDomainInput.value = '';
        }
      });
    };
  }

  /**
   * Set up tab switching functionality
   */
  function setupTabs() {
    tabs.forEach(tab => {
      tab.addEventListener('click', function() {
        // Remove active class from all tabs and contents
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        // Add active class to clicked tab and corresponding content
        this.classList.add('active');
        const tabName = this.getAttribute('data-tab');
        document.getElementById(`${tabName}-content`).classList.add('active');
      });
    });
  }

  /**
   * Get data for the current active tab
   */
  function getCurrentTabData() {
    chrome.runtime.sendMessage({ action: 'getCurrentTab' }, function(response) {
      if (response && response.success && response.data) {
        updateCurrentTabUI(response.data);
      } else {
        setErrorState('Could not get current tab data');
      }
    });
  }

  /**
   * Load productivity statistics
   */
  function loadStatistics() {
    chrome.runtime.sendMessage({ action: 'getStats' }, function(response) {
      if (response && response.success && response.data) {
        updateStatisticsUI(response.data);
        
        // Update cache info if available
        if (response.data.cacheSize !== undefined) {
          cacheInfo.textContent = `Cache: ${response.data.cacheSize} URLs`;
        }
      } else {
        console.error('Could not load statistics');
      }
    });
  }

  /**
   * Update UI with current tab data
   */
  function updateCurrentTabUI(tabData) {
    // Clear any previous analyzing state
    currentSiteCard.classList.remove('analyzing');
    
    // Set URL
    siteUrl.textContent = tabData.domain || 'Unknown';
    
    // If the tab is still being analyzed
    if (tabData.explanation === 'Analyzing...') {
      setAnalyzingState(true);
      return;
    }
    
    // Set status indicator and text
    const scoreValue = Math.min(100, tabData.score || 0);
    const isProductive = scoreValue >= 50; // Enforce 50/100 threshold in the UI
    
    if (isProductive) {
      statusIndicator.className = 'status-indicator productive';
      productivityStatus.textContent = 'Productive';
      productivityStatus.className = 'status productive';
    } else {
      statusIndicator.className = 'status-indicator non-productive';
      productivityStatus.textContent = 'Non-Productive';
      productivityStatus.className = 'status non-productive';
    }
    
    // Set productivity score
    productivityScore.textContent = `Score: ${scoreValue}/100`;
    
    // Set explanation
    statusReason.textContent = tabData.explanation || 'No explanation available';
    
    showOverrideUI(tabData);
  }

  /**
   * Set the UI to analyzing state
   */
  function setAnalyzingState(isAnalyzing) {
    if (isAnalyzing) {
      currentSiteCard.classList.add('analyzing');
      statusIndicator.className = 'status-indicator analyzing';
      productivityStatus.textContent = 'Analyzing...';
      productivityScore.textContent = 'Score: --/100';
    } else {
      currentSiteCard.classList.remove('analyzing');
    }
  }

  /**
   * Set the UI to error state
   */
  function setErrorState(message) {
    statusIndicator.className = 'status-indicator';
    productivityStatus.textContent = 'Error';
    productivityStatus.className = 'status';
    productivityScore.textContent = '';
    statusReason.textContent = message || 'An unknown error occurred';
    statusReason.classList.add('expanded');
    toggleDetails.textContent = 'Hide Details';
  }

  /**
   * Update statistics UI
   */
  function updateStatisticsUI(stats) {
    // Update time values
    productiveTime.textContent = formatTime(stats.productiveTime);
    nonProductiveTime.textContent = formatTime(stats.nonProductiveTime);
    
    // Update progress bar
    productivityPercentage.textContent = `${stats.productivePercentage}%`;
    progressBar.style.width = `${stats.productivePercentage}%`;
    
    // Update domain lists
    updateDomainList(productiveDomainList, stats.productiveDomains, true);
    updateDomainList(nonProductiveDomainList, stats.nonProductiveDomains, false);
  }

  /**
   * Update domain list UI
   */
  function updateDomainList(listElement, domains, isProductive) {
    // Clear the list
    listElement.innerHTML = '';
    
    // Check if there are domains to display
    if (!domains || domains.length === 0) {
      const emptyItem = document.createElement('li');
      emptyItem.textContent = isProductive ? 
        'No productive sites visited yet' : 
        'No non-productive sites visited yet';
      listElement.appendChild(emptyItem);
      return;
    }
    
    // Add each domain to the list
    domains.forEach(domain => {
      const listItem = document.createElement('li');
      listItem.className = 'domain-item';
      
      const header = document.createElement('div');
      header.className = 'domain-header';
      
      const nameElement = document.createElement('div');
      nameElement.className = 'domain-name';
      
      // Check if it's YouTube
      if (domain.domain.includes('youtube.com') || domain.domain.includes('youtu.be')) {
        const youtubeIcon = document.createElement('span');
        youtubeIcon.className = 'youtube-icon';
        nameElement.appendChild(youtubeIcon);
      } else {
        // Add a badge with the first letter of the domain
        const badge = document.createElement('span');
        badge.className = `domain-badge ${isProductive ? 'productive' : 'non-productive'}`;
        badge.textContent = domain.domain.charAt(0).toUpperCase();
        nameElement.appendChild(badge);
      }
      
      // Add domain name
      const domainText = document.createElement('span');
      domainText.textContent = domain.domain;
      nameElement.appendChild(domainText);
      
      const timeElement = document.createElement('div');
      timeElement.className = `domain-time ${isProductive ? 'productive' : 'non-productive'}`;
      timeElement.textContent = formatTime(domain.timeSpent);
      
      header.appendChild(nameElement);
      header.appendChild(timeElement);
      
      listItem.appendChild(header);
      listElement.appendChild(listItem);
    });
  }

  /**
   * Format milliseconds to a readable time string
   */
  function formatTime(milliseconds) {
    if (!milliseconds) return '0s';
    
    const seconds = Math.floor(milliseconds / 1000);
    
    if (seconds < 60) {
      return `${seconds}s`;
    }
    
    const minutes = Math.floor(seconds / 60);
    
    if (minutes < 60) {
      return `${minutes}m`;
    }
    
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    
    return `${hours}h ${remainingMinutes}m`;
  }

  /**
   * Load theme preference from storage
   */
  function loadThemePreference() {
    chrome.storage.local.get(['settings'], function(data) {
      if (data.settings && data.settings.theme) {
        const isDark = data.settings.theme === 'dark';
        setTheme(isDark);
      } else {
        // Default to dark theme
        setTheme(true);
      }
    });
  }

  /**
   * Set theme based on preference
   */
  function setTheme(isDark) {
    if (isDark) {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
    } else {
      document.body.classList.remove('dark-theme');
      document.body.classList.add('light-theme');
    }
  }

  /**
   * Show manual override UI
   */
  function showOverrideUI(tabData) {
    currentUrl = tabData.url;
    overrideUrlSpan.textContent = currentUrl;
    chrome.storage.local.get(['overrides'], (data) => {
      const overrides = data.overrides || {};
      
      // Reset button styles
      markProductiveBtn.style.transform = 'scale(1)';
      markProductiveBtn.style.boxShadow = 'none';
      markNonProductiveBtn.style.transform = 'scale(1)';
      markNonProductiveBtn.style.boxShadow = 'none';
      
      // Reset indicators
      document.getElementById('productive-indicator').style.display = 'none';
      document.getElementById('nonproductive-indicator').style.display = 'none';
      
      if (overrides[currentUrl] === true) {
        overrideStatusDiv.textContent = 'This URL is marked as Productive';
        overrideStatusDiv.style.color = 'var(--productive-color)';
        removeOverrideBtn.style.display = '';
        // Show indicator for productive button
        document.getElementById('productive-indicator').style.display = 'block';
        // Enhance selected button appearance
        markProductiveBtn.style.transform = 'scale(1.05)';
        markProductiveBtn.style.boxShadow = '0 0 8px var(--productive-color)';
      } else if (overrides[currentUrl] === false) {
        overrideStatusDiv.textContent = 'This URL is marked as Non-Productive';
        overrideStatusDiv.style.color = 'var(--non-productive-color)';
        removeOverrideBtn.style.display = '';
        // Show indicator for non-productive button
        document.getElementById('nonproductive-indicator').style.display = 'block';
        // Enhance selected button appearance
        markNonProductiveBtn.style.transform = 'scale(1.05)';
        markNonProductiveBtn.style.boxShadow = '0 0 8px var(--non-productive-color)';
      } else {
        overrideStatusDiv.textContent = 'No manual override set for this URL.';
        overrideStatusDiv.style.color = 'var(--highlight-color)';
        removeOverrideBtn.style.display = 'none';
      }
    });
  }

  /**
   * Load productive mode state
   */
  function loadProductiveModeState() {
    chrome.storage.local.get(['productiveMode'], function(data) {
      if (data.productiveMode && data.productiveMode.enabled) {
        productiveModeToggle.checked = true;
      }
    });
  }

  /**
   * Render blocked domains list
   */
  function renderBlockedDomains(domains) {
    blockedDomainsList.innerHTML = '';
    if (!domains || domains.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No domains blocked.';
      li.style.color = 'var(--neutral-color)';
      blockedDomainsList.appendChild(li);
      return;
    }
    domains.forEach(domain => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.padding = '2px 0';
      li.innerHTML = `<span>${domain}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.style.background = 'var(--neutral-color)';
      removeBtn.style.color = 'white';
      removeBtn.style.border = 'none';
      removeBtn.style.borderRadius = '3px';
      removeBtn.style.padding = '2px 8px';
      removeBtn.style.fontSize = '0.92rem';
      removeBtn.style.cursor = 'pointer';
      removeBtn.onclick = () => {
        chrome.storage.local.get(['userBlockedDomains'], (data) => {
          let userBlockedDomains = data.userBlockedDomains || [];
          userBlockedDomains = userBlockedDomains.filter(d => d !== domain);
          chrome.storage.local.set({ userBlockedDomains }, () => {
            renderBlockedDomains(userBlockedDomains);
            // Notify background to update enforcement
            chrome.runtime.sendMessage({ action: 'userBlockedDomainsChanged', domains: userBlockedDomains });
          });
        });
      };
      li.appendChild(removeBtn);
      blockedDomainsList.appendChild(li);
    });
  }

  /**
   * Load blocked domains from storage
   */
  function loadBlockedDomains() {
    chrome.storage.local.get(['userBlockedDomains'], (data) => {
      renderBlockedDomains(data.userBlockedDomains || []);
    });
  }

  // Refresh data periodically
  setInterval(function() {
    getCurrentTabData();
    loadStatistics();
  }, 5000);
});