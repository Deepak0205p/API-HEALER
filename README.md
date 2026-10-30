# API HEALER ⚡

> **Autonomous Zero-Downtime Resilience & Automated Pull Request Healing Engine for Production APIs**

API Healer is an enterprise-grade control plane and proxy shield designed to prevent breaking API changes, schema drifts, silent 200 OK crashes, and upstream 5xx outages from crashing downstream client applications.

---

## 🚀 Key Highlights & Architecture

- **Sub-Millisecond Runtime Shield**: Intercepts breaking schema drifts, field renames, and payload anomalies in `<0.1ms` via in-memory hot-path routing.
- **3-Gate Deterministic Verification**:
  1. Contract field invariant validation
  2. Welford 4.5σ z-score statistical outlier veto (protects against 100× currency / unit scale bugs)
  3. Fail-closed deterministic sandbox execution
- **Autonomous Multi-Agent Swarm**:
  Powered by Google DeepMind's **`gemini-3.5-flash-lite`**, the cold-path background engine analyzes repository blast radiuses and automatically drafts atomic multi-file GitHub Pull Requests before upstream downtime impacts customers.
- **Production Web Service Ready**:
  Ready for 1-click containerized deployment on Render, Railway, AWS ECS, Google Cloud Run, or VPS. Includes automated keep-alive probes and zero-downtime health endpoints.

---

## 🛠️ Environment Variables Configuration

Set up the following environment variables in your deployment dashboard (e.g. Render Web Service Environment Settings):

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes | Node runtime mode | `production` |
| `PORT` | Yes | Web service port | `3000` |
| `GEMINI_API_KEY` | **Recommended** | Google Gemini API key for `gemini-3.5-flash-lite` agent fixes | `AIzaSy...` |
| `GITHUB_TOKEN` | Optional | GitHub Personal Access Token (`repo` scope) for opening PRs | `ghp_...` |
| `GITHUB_REPO` | Optional | Target GitHub repository to receive automated healing PRs | `username/repository-name` |
| `RENDER_EXTERNAL_URL` | Optional | Public service URL for automatic self-ping keep-alive service | `https://apti-gwq9.onrender.com` |
| `API_HEALER_URL` | Optional | Custom proxy URL passed to client SDK interceptors | `https://api.yourdomain.com` |
| `SQL_HOST` | Optional | Cloud SQL / PostgreSQL host (Uses in-memory store if unset) | `10.x.x.x` or `ep-xxx.neon.tech` |
| `SQL_PORT` | Optional | PostgreSQL Port | `5432` |
| `SQL_USER` | Optional | PostgreSQL Database username | `postgres` |
| `SQL_PASSWORD` | Optional | PostgreSQL Database password | `secret_password` |
| `SQL_DB_NAME` | Optional | PostgreSQL Database name | `apihealer` |

---

## 📦 Local Quickstart & Development

### 1. Install Dependencies
```bash
npm install --legacy-peer-deps
```

### 2. Run API Healer
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## 💳 Standalone Payment Checkout Demo (`Port 4000`)

A companion payment checkout demo app (`payment-checkout-demo`) is included outside this folder to demonstrate live drift injection and instant healing:

1. **Navigate to the demo directory:**
   ```bash
   cd ../payment-checkout-demo
   ```
2. **Install & Run:**
   ```bash
   npm install
   npm start
   ```
3. Open **[http://localhost:4000](http://localhost:4000)** to simulate breaking upstream payment drifts (*Renamed keys, 100× paise anomalies, Silent 200 OK crashes, and HTTP 500 outages*).

---

## 🚢 Deployment (Render / Docker / Cloud Run)

### Web Service Build & Start Commands:
- **Build Command:** `npm run build`
- **Start Command:** `npm run start`
- **Health Check Path:** `/api/health`

---

## 📄 License
MIT License. Built for resilient, zero-downtime modern engineering teams.
