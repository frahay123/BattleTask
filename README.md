# ProductiveTime Backend Server & Chrome Extension

This repository contains the backend server and Chrome extension for **ProductiveTime** (formerly BattleTask), a productivity and screen time tracking tool powered by Google's Gemini API.

---

## Features

- **Real-Time Productivity Analysis:**
  - Uses Google Gemini API to determine if a website or content is productive, educational, or otherwise.
  - Special handling for YouTube to distinguish educational from entertainment content.
- **Screen Time Tracking:**
  - Tracks time spent on productive and non-productive sites.
  - Shows detailed domain statistics and productivity percentages.
- **REST API:**
  - Backend server exposes endpoints for the Chrome extension to analyze URLs and retrieve productivity data.
- **Modern UI:**
  - Popup UI with light/dark mode toggle.
  - Displays current site productivity, time stats, and top domains.

---

## Architecture Overview

### 1. `backend.js` (Chrome Extension Service Worker)
- Handles Gemini API integration for productivity analysis
- Detects tab and URL changes
- Tracks screentime for productive/non-productive activities
- Manages local data storage

### 2. `content.js` (Content Script)
- Injected into web pages
- Detects fullscreen mode and video content
- Tracks user activity, visibility, and focus
- Communicates with the backend

### 3. `popup.js` / `popup.html` (Extension Popup UI)
- Displays productivity status, time stats, and top domains
- Provides light/dark mode toggle

### 4. `server.js` (Backend Express Server)
- Provides REST endpoints for the Chrome extension
- Integrates with Gemini API for educational/productivity analysis

---

## Backend Server Setup

### Prerequisites
- Node.js (v16+ recommended)
- NPM
- A valid [Google Gemini API key](https://ai.google.dev/)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd screentime
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Run the setup script:**
   ```bash
   node setup.js
   ```
   This will:
   - Create a `.env` file with your Gemini API key for the backend
   - Create a `config.js` file from the template for the Chrome extension

4. **Start the server:**
   ```bash
   npm start
   ```
   By default, the server will run on `http://localhost:3000`.

### Manual Setup (Alternative)

If you prefer to set up manually:

1. **Create a `.env` file** in the root directory with your Gemini API key:
   ```
   GEMINI_API_KEY=your_google_gemini_api_key_here
   ```

2. **Create a `config.js` file** by copying `config.template.js` and replacing the placeholder with your API key:
   ```bash
   cp config.template.js config.js
   # Then edit config.js to add your API key
   ```

---

## Chrome Extension Usage

1. **Set up your configuration:**
   ```bash
   # First, make sure you have a .env file with your API key
   # Then run the setup script to securely create config.js
   node setup.js
   ```

2. Go to `chrome://extensions/` in your browser.
3. Enable **Developer Mode**.
4. Click **Load unpacked** and select the `screentime` directory.
5. Use the extension popup to view productivity stats, toggle dark/light mode, and see domain breakdowns.

---

## Security
- **Never commit your `.env` file or API keys to public repositories.**
- The API key is loaded from environment variables for safety in the backend.
- For the extension, use the `setup.js` script to securely generate `config.js` with your API key.
- Both `.env` and `config.js` are in `.gitignore` to prevent accidental exposure.
- **IMPORTANT:** If you've previously committed code with hardcoded API keys, use `git filter-branch` or `BFG Repo Cleaner` to remove them from your git history.

---

## Troubleshooting
- If you receive errors from the Gemini API, ensure your API key is correct and has access to the Gemini model.
- Check your network connection and any firewall settings that may block API requests.
- Use browser DevTools (Console tab) to view extension logs and debug issues.

---

## License
MIT License

---

Feel free to modify this README to match any additional features or deployment instructions you add!
# AIProducitivityExtension
