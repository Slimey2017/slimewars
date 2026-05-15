# Slime Wars — Setup & Run

## Project structure
```
slime-wars/
├── server.js        ← Node/Express/WebSocket server
├── package.json
└── public/
    └── index.html   ← Game client (served statically)
```

## Install & run
```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## Deploy (e.g. Railway, Render, Fly.io)
Set the `PORT` environment variable — the server reads it automatically:
```
PORT=8080 npm start
```
The client auto-detects `ws://` vs `wss://` based on the page protocol,
so HTTPS deployments get a secure WebSocket connection for free.
