'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// ─── Serve static files (the game HTML) ───────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Server health check (Render.com needs this) ──────────────────
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ─── In-memory state ──────────────────────────────────────────────
// rooms: Map<roomId, Room>
const rooms = new Map();
// players: Map<ws, Player>
const players = new Map();

const MAX_ROOM_PLAYERS = 12;
const TICK_RATE = 20; // ms — 50 Hz server tick

// ─── Room factory ─────────────────────────────────────────────────
function createRoom(name, mode) {
  const id = uuidv4().slice(0, 8).toUpperCase();
  const room = {
    id,
    name: name || `SLIME-${id}`,
    mode: mode || 'ffa',   // 'ffa' | 'tdm'
    state: 'lobby',        // 'lobby' | 'ingame' | 'gameover'
    players: new Map(),    // socketId -> playerState
    scores: {},
    scoreLimit: mode === 'tdm' ? 50 : 30,
    startTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

// ─── Helpers ──────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg, exceptWs = null) {
  room.players.forEach((_, socketId) => {
    const ws = getWsBySocketId(socketId);
    if (ws && ws !== exceptWs) send(ws, msg);
  });
}

function getWsBySocketId(socketId) {
  for (const [ws, p] of players.entries()) {
    if (p.socketId === socketId) return ws;
  }
  return null;
}

function getRoomList() {
  const list = [];
  rooms.forEach(room => {
    if (room.state !== 'gameover') {
      list.push({
        id: room.id,
        name: room.name,
        mode: room.mode,
        players: room.players.size,
        max: MAX_ROOM_PLAYERS,
        state: room.state,
        ping: Math.floor(Math.random() * 40) + 10, // approximate
      });
    }
  });
  return list;
}

function getLobbyPlayers(room) {
  const list = [];
  room.players.forEach((p, sid) => {
    list.push({
      socketId: sid,
      name: p.name,
      skin: p.skin,
      hat: p.hat,
      face: p.face,
      ready: p.ready,
    });
  });
  return list;
}

// Auto-create a default public room so there's always something to join
function ensurePublicRooms() {
  let publicCount = 0;
  rooms.forEach(r => { if (r.state === 'lobby') publicCount++; });
  if (publicCount < 2) {
    createRoom('SLIMEVILLE', 'ffa');
    createRoom('GOO CANYON', 'tdm');
  }
}
ensurePublicRooms();

// Clean up old empty gameover rooms every 60s
setInterval(() => {
  rooms.forEach((room, id) => {
    if (room.players.size === 0 && room.state === 'gameover') {
      rooms.delete(id);
    }
  });
  ensurePublicRooms();
}, 60_000);

// ─── WebSocket connection ──────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const socketId = uuidv4();
  players.set(ws, {
    socketId,
    roomId: null,
    name: 'SlimeyPlayer',
    skin: 0,
    hat: '🚫',
    face: '😐',
    ready: false,
    x: 2500, y: 2500,
    angle: 0,
    hp: 100,
    armor: 0,
    dead: false,
    kills: 0,
    deaths: 0,
    team: 0,
    slotIdx: 0,
    inv: [],
    pingTs: Date.now(),
  });

  // Welcome — send socket ID and current room list
  send(ws, { type: 'welcome', socketId, rooms: getRoomList() });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', () => {
    handleDisconnect(ws);
  });
});

// ─── Message router ───────────────────────────────────────────────
function handleMessage(ws, msg) {
  const player = players.get(ws);
  if (!player) return;

  switch (msg.type) {

    // ── Room browsing ─────────────────────────────────────────────
    case 'get_rooms':
      send(ws, { type: 'room_list', rooms: getRoomList() });
      break;

    case 'create_room': {
      const room = createRoom(msg.name, msg.mode);
      joinRoom(ws, room.id, msg.playerInfo);
      break;
    }

    case 'join_room':
      joinRoom(ws, msg.roomId, msg.playerInfo);
      break;

    case 'quick_join': {
      // Find a lobby room with space
      let target = null;
      for (const [, r] of rooms) {
        if (r.state === 'lobby' && r.players.size < MAX_ROOM_PLAYERS) {
          target = r; break;
        }
      }
      if (!target) target = createRoom('SLIMEVILLE', 'ffa');
      joinRoom(ws, target.id, msg.playerInfo);
      break;
    }

    case 'leave_room':
      leaveRoom(ws);
      break;

    // ── Lobby ─────────────────────────────────────────────────────
    case 'update_player': {
      // Player updated name/skin/hat/face
      Object.assign(player, msg.info || {});
      const room = player.roomId ? rooms.get(player.roomId) : null;
      if (room) {
        const rp = room.players.get(player.socketId);
        if (rp) Object.assign(rp, msg.info || {});
        broadcast(room, {
          type: 'lobby_players',
          players: getLobbyPlayers(room),
        });
      }
      break;
    }

    case 'set_ready': {
      const room = getPlayerRoom(player);
      if (!room) break;
      const rp = room.players.get(player.socketId);
      if (rp) rp.ready = msg.ready;
      broadcast(room, {
        type: 'lobby_players',
        players: getLobbyPlayers(room),
      });
      checkAutoStart(room);
      break;
    }

    case 'lobby_chat': {
      const room = getPlayerRoom(player);
      if (!room) break;
      broadcast(room, {
        type: 'lobby_chat',
        name: player.name,
        text: String(msg.text || '').slice(0, 120),
      });
      break;
    }

    case 'set_mode': {
      // Mode is locked at room creation — reject any attempt to change it
      send(ws, { type: 'error', msg: 'Game mode is locked and cannot be changed after room creation.' });
      break;
    }

    case 'force_start': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'lobby') break;
      startGame(room);
      break;
    }

    // ── In-game ───────────────────────────────────────────────────
    case 'player_update': {
      // Client sends its own state every frame
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      const rp = room.players.get(player.socketId);
      if (!rp) break;
      // Update authoritative position (trust client for now — no cheating prevention needed for casual game)
      Object.assign(rp, {
        x: msg.x, y: msg.y,
        angle: msg.angle,
        hp: msg.hp,
        armor: msg.armor,
        dead: msg.dead,
        slotIdx: msg.slotIdx,
        inv: msg.inv,
        skin: rp.skin, // don't overwrite from in-game
      });
      // Relay to everyone else (delta broadcast)
      broadcast(room, {
        type: 'player_update',
        socketId: player.socketId,
        x: msg.x, y: msg.y,
        angle: msg.angle,
        hp: msg.hp,
        armor: msg.armor,
        dead: msg.dead,
        slotIdx: msg.slotIdx,
        inv: msg.inv,
      }, ws);
      break;
    }

    case 'bullet_fired': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      // Relay bullet — fields are top-level on msg (not nested under msg.bullet)
      broadcast(room, {
        type: 'bullet_fired',
        socketId: player.socketId,
        x: msg.x, y: msg.y,
        vx: msg.vx, vy: msg.vy,
        dmg: msg.dmg,
        range: msg.range,
        r: msg.r,
        expl: msg.expl,
        color: msg.color,
        flame: msg.flame,
        laser: msg.laser,
      }, ws);
      break;
    }

    case 'explosion': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type: 'explosion',
        socketId: player.socketId,
        x: msg.x, y: msg.y,
        radius: msg.radius,
        damage: msg.damage,
      }, ws);
      break;
    }

    case 'player_hit':   // legacy name — fall through
    case 'hit_player': {
      // Client reports hitting a real remote player
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      const targetRp = room.players.get(msg.targetId);
      if (!targetRp || targetRp.dead) break; // already dead, ignore

      // Clamp damage to prevent abuse
      const damage = Math.min(Math.max(Number(msg.damage) || 0, 0), 500);

      // Apply damage server-side
      const absorbed = targetRp.armor > 0
        ? Math.min(targetRp.armor, Math.round(damage * 0.4))
        : 0;
      targetRp.armor = Math.max(0, targetRp.armor - absorbed);
      targetRp.hp   = Math.max(0, targetRp.hp - (damage - absorbed));

      const targetWs = getWsBySocketId(msg.targetId);
      if (targetWs) {
        send(targetWs, {
          type: 'you_hit',
          damage,
          attackerId: player.socketId,
          weapon: msg.weapon,
        });
      }

      const killed = targetRp.hp <= 0 && !targetRp.dead;
      // Send hitmarker back to the shooter
      send(ws, { type: 'hitmarker', kill: killed });

      if (killed) {
        targetRp.dead = true; // mark now to prevent double-kill

        const killerScore = room.scores[player.socketId]
          || (room.scores[player.socketId] = { k: 0, d: 0, score: 0 });
        killerScore.k++;
        killerScore.score += 100;

        const victimScore = room.scores[msg.targetId]
          || (room.scores[msg.targetId] = { k: 0, d: 0, score: 0 });
        victimScore.d++;

        const killerRp = room.players.get(player.socketId);
        if (killerRp) killerRp.kills = (killerRp.kills || 0) + 1;
        targetRp.deaths = (targetRp.deaths || 0) + 1;

        if (targetWs) {
          send(targetWs, {
            type: 'you_died',
            killerId: player.socketId,
            killerName: player.name,
            weapon: msg.weapon,
          });
        }

        broadcast(room, {
          type: 'kill_event',
          killerId: player.socketId,
          killerName: player.name,
          victimId: msg.targetId,
          victimName: targetRp.name || '???',
          weapon: msg.weapon,
          scores: room.scores,
        });

        checkWinCondition(room);
      }
      break;
    }

    case 'player_killed': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;

      // Update scores
      const killerRp = room.players.get(player.socketId);
      if (killerRp) {
        killerRp.kills = (killerRp.kills || 0) + 1;
        if (!room.scores[player.socketId]) room.scores[player.socketId] = { k: 0, d: 0, score: 0 };
        room.scores[player.socketId].k++;
        room.scores[player.socketId].score += 100;
      }

      const victimRp = room.players.get(msg.victimId);
      if (victimRp) {
        victimRp.deaths = (victimRp.deaths || 0) + 1;
        if (!room.scores[msg.victimId]) room.scores[msg.victimId] = { k: 0, d: 0, score: 0 };
        room.scores[msg.victimId].d++;
      }

      // Notify victim to respawn
      const victimWs = getWsBySocketId(msg.victimId);
      if (victimWs) {
        send(victimWs, {
          type: 'you_died',
          killerId: player.socketId,
          killerName: player.name,
          weapon: msg.weapon,
        });
      }

      // Tell attacker they got the kill
      send(ws, { type: 'hitmarker', kill: true });

      // Broadcast kill to room
      broadcast(room, {
        type: 'kill_event',
        killerId: player.socketId,
        killerName: player.name,
        victimId: msg.victimId,
        victimName: msg.victimName,
        weapon: msg.weapon,
        scores: room.scores,
      });

      // Check win condition
      checkWinCondition(room);
      break;
    }

    case 'game_chat': {
      const room = getPlayerRoom(player);
      if (!room) break;
      broadcast(room, {
        type: 'game_chat',
        name: player.name,
        text: String(msg.text || '').slice(0, 120),
      });
      break;
    }

    case 'streak_used': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type: 'streak_used',
        socketId: player.socketId,
        streak: msg.streak,
        x: msg.x, y: msg.y,
      }, ws);
      break;
    }

    case 'weapon_pickup': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      // Relay to everyone so spawns disappear for all
      broadcast(room, {
        type: 'weapon_pickup',
        socketId: player.socketId,
        spawnIdx: msg.spawnIdx,
      }, ws);
      break;
    }

    case 'ping':
      player.pingTs = Date.now();
      send(ws, { type: 'pong', ts: msg.ts });
      break;

    default:
      break;
  }
}

// ─── Join / leave room ────────────────────────────────────────────
function joinRoom(ws, roomId, info = {}) {
  const player = players.get(ws);
  if (!player) return;

  // Leave current room first
  if (player.roomId) leaveRoom(ws);

  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', msg: 'Room not found' });
    return;
  }
  if (room.players.size >= MAX_ROOM_PLAYERS) {
    send(ws, { type: 'error', msg: 'Room is full' });
    return;
  }
  if (room.state === 'gameover') {
    send(ws, { type: 'error', msg: 'Game already ended' });
    return;
  }

  // Apply player info
  if (info.name) player.name = String(info.name).slice(0, 24);
  if (info.skin !== undefined) player.skin = info.skin;
  if (info.hat !== undefined) player.hat = info.hat;
  if (info.face !== undefined) player.face = info.face;

  player.roomId = roomId;
  player.ready = false;

  // Assign team in TDM
  if (room.mode === 'tdm') {
    const teams = { 0: 0, 1: 0 };
    room.players.forEach(p => teams[p.team] = (teams[p.team] || 0) + 1);
    player.team = teams[0] <= teams[1] ? 0 : 1;
  }

  room.players.set(player.socketId, {
    socketId: player.socketId,
    name: player.name,
    skin: player.skin,
    hat: player.hat,
    face: player.face,
    ready: false,
    kills: 0,
    deaths: 0,
    team: player.team,
    x: 2500, y: 2500,
    angle: 0,
    hp: 100,
    armor: 0,
    dead: false,
    slotIdx: 0,
    inv: [],
  });
  room.scores[player.socketId] = { k: 0, d: 0, score: 0 };

  // Tell this client they joined
  send(ws, {
    type: 'joined_room',
    roomId: room.id,
    roomName: room.name,
    mode: room.mode,
    state: room.state,
    socketId: player.socketId,
    players: getLobbyPlayers(room),
    scores: room.scores,
  });

  // Tell everyone else a player joined
  broadcast(room, {
    type: 'player_joined',
    player: { socketId: player.socketId, name: player.name, skin: player.skin, hat: player.hat, face: player.face },
    players: getLobbyPlayers(room),
  }, ws);

  // If game is already running, send them right in
  if (room.state === 'ingame') {
    send(ws, { type: 'game_start', mode: room.mode, scores: room.scores });
  }
}

function leaveRoom(ws) {
  const player = players.get(ws);
  if (!player || !player.roomId) return;
  const room = rooms.get(player.roomId);
  player.roomId = null;
  if (!room) return;

  room.players.delete(player.socketId);
  delete room.scores[player.socketId];

  broadcast(room, {
    type: 'player_left',
    socketId: player.socketId,
    name: player.name,
    players: getLobbyPlayers(room),
  });

  // If room empty, clean up timer
  if (room.players.size === 0 && room.startTimer) {
    clearTimeout(room.startTimer);
    room.startTimer = null;
  }
}

function handleDisconnect(ws) {
  leaveRoom(ws);
  players.delete(ws);
}

// ─── Game flow ────────────────────────────────────────────────────
function checkAutoStart(room) {
  if (room.state !== 'lobby') return;
  if (room.players.size < 2) return;
  let allReady = true;
  room.players.forEach(p => { if (!p.ready) allReady = false; });
  if (allReady) startCountdown(room);
}

function startCountdown(room) {
  if (room.startTimer) return; // already counting
  let count = 5;
  broadcast(room, { type: 'start_countdown', seconds: count });
  room.startTimer = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(room.startTimer);
      room.startTimer = null;
      startGame(room);
    } else {
      broadcast(room, { type: 'start_countdown', seconds: count });
    }
  }, 1000);
}

function startGame(room) {
  if (room.state === 'ingame') return;
  room.state = 'ingame';
  // Reset scores
  room.scores = {};
  room.players.forEach((_, sid) => { room.scores[sid] = { k: 0, d: 0, score: 0 }; });

  broadcast(room, {
    type: 'game_start',
    mode: room.mode,
    scoreLimit: room.scoreLimit,
    scores: room.scores,
    players: getLobbyPlayers(room),
  });
}

function checkWinCondition(room) {
  if (room.state !== 'ingame') return;

  if (room.mode === 'ffa') {
    let winner = null;
    Object.entries(room.scores).forEach(([sid, s]) => {
      if (s.k >= room.scoreLimit) winner = sid;
    });
    if (winner) {
      const wp = room.players.get(winner);
      endGame(room, wp ? wp.name : 'Unknown', winner);
    }
  } else {
    // TDM — sum kill counts per team
    const team = { 0: 0, 1: 0 };
    Object.entries(room.scores).forEach(([sid, s]) => {
      const p = room.players.get(sid);
      if (p) team[p.team] = (team[p.team] || 0) + s.k;
    });
    if (team[0] >= room.scoreLimit) endGame(room, 'BLUE TEAM', null);
    else if (team[1] >= room.scoreLimit) endGame(room, 'RED TEAM', null);
  }
}

function endGame(room, winnerName, winnerSocketId) {
  room.state = 'gameover';
  broadcast(room, {
    type: 'game_over',
    winnerName,
    winnerSocketId,
    scores: room.scores,
    players: getLobbyPlayers(room),
  });

  // After 15s, reset room to lobby so same players can rematch
  setTimeout(() => {
    if (room.players.size === 0) {
      rooms.delete(room.id);
    } else {
      room.state = 'lobby';
      room.scores = {};
      room.players.forEach((p, sid) => {
        p.ready = false;
        p.kills = 0;
        p.deaths = 0;
        room.scores[sid] = { k: 0, d: 0, score: 0 };
      });
      broadcast(room, {
        type: 'rematch_lobby',
        players: getLobbyPlayers(room),
      });
    }
  }, 15_000);
}

// ─── Helpers ──────────────────────────────────────────────────────
function getPlayerRoom(player) {
  if (!player.roomId) return null;
  return rooms.get(player.roomId) || null;
}

// ─── Server tick — broadcast full room snapshots ───────────────────
// Only send snapshots for ingame rooms to avoid flooding lobby
setInterval(() => {
  rooms.forEach(room => {
    if (room.state !== 'ingame') return;
    const snapshot = [];
    room.players.forEach((p, sid) => {
      snapshot.push({
        socketId: sid,
        name: p.name,
        skin: p.skin,
        hat: p.hat,
        face: p.face,
        x: p.x, y: p.y,
        angle: p.angle,
        hp: p.hp,
        armor: p.armor,
        dead: p.dead,
        team: p.team,
        kills: p.kills,
      });
    });
    broadcast(room, {
      type: 'world_snapshot',
      players: snapshot,
      scores: room.scores,
    });
  });
}, TICK_RATE);

// ─── Start ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Slime Wars server running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   HTTP:      http://localhost:${PORT}`);
});
