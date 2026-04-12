# 🟢 Slime Wars — Multiplayer Server

Real WebSocket multiplayer for **Slime Wars v3 Arsenal Edition**.  
Built for deployment on **Render.com free plan**.

---

## 📁 File Structure

```
slimewars-server/
├── server.js          ← Real WebSocket + HTTP server
├── package.json       ← Dependencies (express, ws, uuid)
├── package-lock.json  ← Lock file (auto-generated)
├── render.yaml        ← Render.com deploy config
└── public/
    └── index.html     ← The game (patched for multiplayer)
```

---

## 🚀 Deploy to Render.com (Free Plan) — Step by Step

### Step 1 — Push to GitHub

1. Create a new **GitHub repo** (e.g. `slimewars`)
2. Upload this entire folder to it:
   - `server.js`
   - `package.json`
   - `package-lock.json`
   - `render.yaml`
   - `public/index.html`

   ```bash
   git init
   git add .
   git commit -m "slime wars multiplayer"
   git remote add origin https://github.com/YOUR_USERNAME/slimewars.git
   git push -u origin main
   ```

### Step 2 — Create a Web Service on Render

1. Go to **[render.com](https://render.com)** and log in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account and select your `slimewars` repo
4. Fill in the settings:
   | Field | Value |
   |-------|-------|
   | **Name** | `slimewars` |
   | **Region** | US East (Ohio) or closest to you |
   | **Branch** | `main` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | **Free** |

5. Click **"Create Web Service"**
6. Wait ~2 minutes for the first deploy

### Step 3 — Share with Friends!

Your game URL will be:
```
https://slimewars.onrender.com
```
(or whatever name you chose)

Send that URL to anyone — they open it in their browser and can play with you instantly!

---

## ⚠️ Render Free Plan Notes

- **Spins down after 15 min of inactivity** — first player to visit waits ~30s for the server to wake up
- To keep it always awake, use a free uptime monitor like [UptimeRobot](https://uptimerobot.com) pinging `/health` every 5 minutes
- **750 free hours/month** — enough for 1 server running 24/7

---

## 🎮 How Multiplayer Works

| Feature | Details |
|---------|---------|
| **Rooms** | Server auto-creates 2 public rooms (FFA + TDM) on startup |
| **Max players** | 12 per room |
| **Create room** | Click "+ CREATE ROOM" in the server browser |
| **Quick join** | Click any row in the server browser |
| **Ready system** | All players ready → 5-second countdown → game starts |
| **Player sync** | Position, HP, angle broadcast at 50Hz |
| **Bullets** | Fired bullets relayed to all players in room |
| **Kill feed** | Real kills broadcast to whole room |
| **Chat** | Lobby chat + in-game chat over WebSocket |
| **Game over** | First to score limit wins; 15s then back to lobby |
| **Solo mode** | "SOLO PRACTICE" on main menu still works with AI bots |

---

## 🛠️ Run Locally

```bash
npm install
npm start
# Open http://localhost:3000
```

Then open **multiple browser tabs** to test multiplayer locally!

---

## 🔧 Configuration

Edit `server.js` to change:
- `MAX_ROOM_PLAYERS` — players per room (default: 12)
- `TICK_RATE` — server tick in ms (default: 20ms = 50Hz)
- Score limits are set per-room when created
