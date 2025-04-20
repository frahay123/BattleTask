/**
 * Configuration file for BattleTask Extension
 *
 * IMPORTANT: Copy this file to config.js and add your Gemini API key
 * DO NOT commit your actual config.js file to version control
 */

var CONFIG = {
  // API Key - Replace with your actual Gemini API key
  GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY_HERE',

  // API Endpoint
  GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',

  // Application settings
  UPDATE_INTERVAL: 30000,
  ACTIVITY_TIMEOUT: 30000,
  MAX_DOMAINS_DISPLAY: 4,
};

// For Node.js environment (backend), override with environment variables if available
if (typeof process !== 'undefined' && process.env && process.env.GEMINI_API_KEY) {
  CONFIG.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
}
