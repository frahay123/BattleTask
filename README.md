# BattleTask (ProductiveTime) – AI-Powered Productivity Chrome Extension

BattleTask (also known as ProductiveTime) is a modern Chrome extension that helps you track, analyze, and improve your online productivity using AI. It leverages Google’s Gemini API for smart content analysis and features a robust backend deployed on Google Cloud Run.

---

## Features

- **AI Productivity Analysis:** Uses Google Gemini API to determine if your browsing is productive or educational.
- **Real-Time Tracking:** Monitors tab activity, user focus, and time spent on each site.
- **Privacy-First:** Data is stored securely; sensitive keys are never exposed to the frontend.
- **Cloud-Native Backend:** All analysis and data storage are handled by a scalable Node.js/Express backend on Google Cloud Run.

---

## Architecture

- **Frontend:** Chrome Extension (JavaScript, HTML, CSS)
- **Backend:** Node.js/Express server, containerized with Docker, deployed on Google Cloud Run
- **AI Integration:** Google Gemini API (via backend)

---

## Setup & Installation

### 1. **Clone the Repository**
```bash
git clone https://github.com/yourusername/battletask.git
cd battletask
```

### 2. **Backend Setup (Cloud Run)**
- Create a `.env` file with your secrets:
  ```
  GEMINI_API_KEY=your-gemini-api-key
  ```
- Build and deploy the backend Docker image to Google Cloud Run:
  ```bash
  gcloud builds submit --tag gcr.io/your-project-id/battletask-backend
  gcloud run deploy battletask-backend --image gcr.io/your-project-id/battletask-backend --platform managed --region us-central1 --allow-unauthenticated
  ```
- Note the backend URL provided by Cloud Run.

### 3. **Frontend Setup (Chrome Extension)**
- Update `config.js` with your Cloud Run backend URL.
- Go to `chrome://extensions`, enable Developer Mode, and click "Load unpacked".
- Select the `screentime` (or extension) directory.

---

## Usage

- Click the extension icon to view your productivity stats.
- The extension will automatically analyze your browsing activity and provide feedback on productivity.

---

## Privacy & Security

- All sensitive data is processed on the backend; no API keys are exposed in the extension.
- See [PRIVACY.md](https://yourdomain.com/privacy) for details.

---

## Tech Stack

- Chrome Extension APIs
- Node.js, Express
- Docker, Google Cloud Run
- Google Gemini API

---

## License

MIT License

---

## Contributing

Pull requests are welcome! For major changes, please open an issue first.

---

## Support

For questions or support, contact [youremail@domain.com](mailto:youremail@domain.com).
