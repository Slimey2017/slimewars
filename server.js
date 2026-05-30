'use strict';
 
const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
 
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
 
const PORT             = process.env.PORT || 3000;
const MAX_ROOM_PLAYERS = 12;
const TICK_MS          = 50;   // 20 Hz world snapshots
 
// ─── Static files ───────────────────────────────────────────────────
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(publicDir));
app.get('/', (_req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send('index.html not found. Place it in the public/ folder or alongside server.js.');
});
app.get('/health', (_req, res) =>
  res.json({ ok: true, rooms: rooms.size, players: players.size }));
 
// ─── In-memory state ────────────────────────────────────────────────
const rooms   = new Map();
const players = new Map();

// ─── KOTH constants ─────────────────────────────────────────────────
const KOTH_WIN          = 100;
const KOTH_ROTATE_TIME  = 30;   // seconds per hill
const KOTH_SCORE_RATE   = 8;    // pts/s while holding
const KOTH_CAPTURE_RATE = 60;   // %/s (0-100 scale per side)
const KOTH_BASE_POSITIONS = [
  { x: 1400, y: 1400 },
  { x: 3600, y: 1400 },
  { x: 2500, y: 3600 },
];
 
// ─── Room factory ───────────────────────────────────────────────────
function createRoom(name, mode, map) {
  const id = uuidv4().slice(0, 8).toUpperCase();
  const validMode = ['ffa','tdm','gungame','koth','infection'].includes(mode) ? mode : 'ffa';
  const validMap  = ['city','forest'].includes(map) ? map : 'city';
  const room = {
    id,
    name      : name || `SLIME-${id}`,
    mode      : validMode,
    map       : validMap,
    state     : 'lobby',
    players   : new Map(),
    scores    : {},
    scoreLimit: validMode === 'tdm' ? 50 : validMode === 'gungame' ? 22 : validMode === 'koth' ? KOTH_WIN : 30,
    startTimer: null,
    createdAt : Date.now(),
    rematchVotes: new Set(),
    hostId    : null,
    // KOTH state
    koth: null,
    // Infection state
    infState: { phase: 'lobby', timeLeft: 180, firstInfectedId: null },
  };
  rooms.set(id, room);
  return room;
}

// ─── KOTH helpers ────────────────────────────────────────────────────
function initKOTH(room) {
  room.koth = {
    zones: KOTH_BASE_POSITIONS.map((p, i) => ({
      x: p.x, y: p.y, r: 130,
      label: ['A','B','C'][i],
      captureProgress: 0,   // -100 (enemy) to +100 (player-side)
      captured: null,       // null | 'blue' | 'red'
    })),
    hillIdx    : 0,
    hillTimer  : KOTH_ROTATE_TIME,
    scores     : {},        // socketId -> pts
    teamScores : { blue: 0, red: 0 },
    lastTick   : Date.now(),
  };
}

function tickKOTH(room, dtSec) {
  const k = room.koth;
  if (!k) return;

  k.hillTimer -= dtSec;
  if (k.hillTimer <= 0) {
    k.hillTimer = KOTH_ROTATE_TIME;
    const zone = k.zones[k.hillIdx];
    zone.captureProgress = 0;
    zone.captured = null;
    k.hillIdx = (k.hillIdx + 1) % k.zones.length;
    broadcast(room, {
      type   : 'koth_hill_moved',
      hillIdx: k.hillIdx,
      label  : k.zones[k.hillIdx].label,
    });
  }

  const zone = k.zones[k.hillIdx];

  // Count players in zone by team
  const blueIn = [], redIn = [];
  room.players.forEach((rp, sid) => {
    if (rp.dead) return;
    const dist = Math.hypot(rp.x - zone.x, rp.y - zone.y);
    if (dist < zone.r) {
      if (rp.team === 0) blueIn.push(sid);
      else redIn.push(sid);
    }
  });

  const contested = blueIn.length > 0 && redIn.length > 0;
  const rate = KOTH_CAPTURE_RATE * dtSec;

  if (!contested) {
    if (blueIn.length > 0) {
      zone.captureProgress = Math.min(100, zone.captureProgress + rate);
      if (zone.captureProgress >= 100) zone.captured = 'blue';
    } else if (redIn.length > 0) {
      zone.captureProgress = Math.max(-100, zone.captureProgress - rate);
      if (zone.captureProgress <= -100) zone.captured = 'red';
    } else {
      // decay to neutral
      if (zone.captureProgress > 0) zone.captureProgress = Math.max(0, zone.captureProgress - rate * 0.5);
      else if (zone.captureProgress < 0) zone.captureProgress = Math.min(0, zone.captureProgress + rate * 0.5);
      if (Math.abs(zone.captureProgress) < 3) zone.captured = null;
    }
  }

  // Score points for held zone
  const scoreRate = KOTH_SCORE_RATE * dtSec;
  if (zone.captured === 'blue') {
    k.teamScores.blue = Math.min(KOTH_WIN, k.teamScores.blue + scoreRate);
    blueIn.forEach(sid => {
      k.scores[sid] = Math.min(KOTH_WIN, (k.scores[sid] || 0) + scoreRate / Math.max(blueIn.length, 1));
    });
  } else if (zone.captured === 'red') {
    k.teamScores.red = Math.min(KOTH_WIN, k.teamScores.red + scoreRate);
    redIn.forEach(sid => {
      k.scores[sid] = Math.min(KOTH_WIN, (k.scores[sid] || 0) + scoreRate / Math.max(redIn.length, 1));
    });
  }

  // Check win
  if (k.teamScores.blue >= KOTH_WIN) { endGame(room, 'BLUE TEAM', null); return; }
  if (k.teamScores.red  >= KOTH_WIN) { endGame(room, 'RED TEAM',  null); return; }
}
 
// ─── Helpers ────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}
 
function broadcast(room, msg, exceptWs = null) {
  room.players.forEach((_, sid) => {
    const ws = wsBySocketId(sid);
    if (ws && ws !== exceptWs) send(ws, msg);
  });
}
 
function wsBySocketId(socketId) {
  for (const [ws, p] of players) {
    if (p.socketId === socketId) return ws;
  }
  return null;
}
 
function getPlayerRoom(player) {
  if (!player.roomId) return null;
  return rooms.get(player.roomId) || null;
}
 
function getRoomList() {
  const list = [];
  rooms.forEach(r => {
    list.push({
      id        : r.id,
      name      : r.name,
      mode      : r.mode,
      players   : r.players.size,
      max       : MAX_ROOM_PLAYERS,
      state     : r.state,
      locked    : !!r.locked,
      isPrivate : !!r.isPrivate,
      ping      : Math.floor(Math.random() * 40) + 5,
    });
  });
  return list;
}
 
function getLobbyPlayers(room) {
  const list = [];
  room.players.forEach((p, sid) => list.push({
    socketId: sid,
    name    : p.name,
    skin    : p.skin,
    hat     : p.hat,
    face    : p.face,
    ready   : p.ready,
    team    : p.team,
  }));
  return list;
}
 
function getOrInitScore(room, socketId, name) {
  if (!room.scores[socketId])
    room.scores[socketId] = { k: 0, d: 0, score: 0, name: name || '???' };
  return room.scores[socketId];
}
 
function applyPlayerInfo(target, info) {
  if (info.name  !== undefined) target.name  = String(info.name).slice(0, 24);
  if (info.skin  !== undefined) target.skin  = info.skin;
  if (info.hat   !== undefined) target.hat   = info.hat;
  if (info.face  !== undefined) target.face  = info.face;
}
 
// ─── Default public rooms ───────────────────────────────────────────
function ensurePublicRooms() {
  let lobbies = 0;
  rooms.forEach(r => { if (r.state === 'lobby') lobbies++; });
  if (lobbies < 3) {
    createRoom('SLIMEVILLE',      'ffa');
    createRoom('GOO CANYON',      'tdm');
    createRoom('GUN GAME ARENA',  'gungame');
    createRoom('KING OF THE HILL','koth');
    createRoom('INFECTION',       'infection');
  }
}
ensurePublicRooms();
 
setInterval(() => {
  rooms.forEach((r, id) => {
    if (r.players.size === 0 && r.state === 'gameover') rooms.delete(id);
  });
  ensurePublicRooms();
}, 60_000);
 
// ─── Connection ─────────────────────────────────────────────────────
wss.on('connection', ws => {
  const socketId = uuidv4();
  players.set(ws, {
    socketId,
    roomId : null,
    name   : 'SlimeyPlayer',
    skin   : 0,
    hat    : '🚫',
    face   : '😐',
    ready  : false,
    team   : 0,
    infTeam: 0,
    x: 2500, y: 2500, angle: 0,
    hp: 100, armor: 0, dead: false,
    kills: 0, deaths: 0,
    slotIdx: 0, inv: [],
    pingTs : Date.now(),
  });
 
  send(ws, { type: 'welcome', socketId, rooms: getRoomList() });
 
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});
 
// ─── Message router ─────────────────────────────────────────────────
function handleMessage(ws, msg) {
  const player = players.get(ws);
  if (!player) return;
 
  switch (msg.type) {
 
    // ── Room browsing ──────────────────────────────────────────────
    case 'get_rooms':
      send(ws, { type: 'room_list', rooms: getRoomList() });
      break;
 
    case 'create_room': {
      const room = createRoom(msg.name, msg.mode, msg.map);
      room.hostId = player.socketId;
      if (msg.locked) {
        room.locked    = true;
        room.password  = msg.password ? String(msg.password).slice(0, 32) : null;
        room.isPrivate = true;
      }
      joinRoom(ws, room.id, msg.playerInfo);
      break;
    }
 
    case 'join_room':
      joinRoom(ws, msg.roomId, msg.playerInfo);
      break;
 
    case 'quick_join': {
      let target = null;
      for (const [, r] of rooms) {
        if (r.state === 'lobby' && !r.locked && r.players.size < MAX_ROOM_PLAYERS) { target = r; break; }
      }
      if (!target) target = createRoom('SLIMEVILLE', 'ffa');
      joinRoom(ws, target.id, msg.playerInfo);
      break;
    }
 
    case 'leave_room':
      leaveRoom(ws);
      break;
 
    // ── Lobby ──────────────────────────────────────────────────────
    case 'update_player': {
      const info = msg.info || {};
      applyPlayerInfo(player, info);
      const room = getPlayerRoom(player);
      if (room) {
        const rp = room.players.get(player.socketId);
        if (rp) applyPlayerInfo(rp, info);
        broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
      }
      break;
    }
 
    case 'set_ready': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'lobby') break;
      const rp = room.players.get(player.socketId);
      if (rp) rp.ready = !!msg.ready;
      broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
      checkAutoStart(room);
      break;
    }
 
    case 'lobby_chat': {
      const room = getPlayerRoom(player);
      if (!room) break;
      const text = String(msg.text || '').slice(0, 120);
      if (text.startsWith('/kick ') && room.hostId === player.socketId) {
        const targetName = text.slice(6).trim().toLowerCase();
        let kicked = false;
        room.players.forEach((rp, sid) => {
          if (rp.name.toLowerCase() === targetName && sid !== player.socketId) {
            const targetWs = wsBySocketId(sid);
            if (targetWs) { send(targetWs, { type: 'kick' }); leaveRoom(targetWs); kicked = true; }
          }
        });
        if (kicked) {
          broadcast(room, { type: 'lobby_chat', name: 'SERVER', text: `${targetName} was kicked.` });
          broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
        } else {
          send(ws, { type: 'lobby_chat', name: 'SERVER', text: `Player "${targetName}" not found.` });
        }
        break;
      }
      broadcast(room, { type: 'lobby_chat', name: player.name, text });
      break;
    }
 
    case 'set_mode':
      send(ws, { type: 'error', msg: 'Game mode is locked.' });
      break;
 
    case 'switch_team': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'lobby' || room.mode !== 'tdm') break;
      const rp = room.players.get(player.socketId);
      if (!rp) break;
      const newTeam = rp.team === 0 ? 1 : 0;
      rp.team = newTeam;
      player.team = newTeam;
      broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
      break;
    }
 
    case 'force_start': {
      const room = getPlayerRoom(player);
      if (room && room.state === 'lobby') startGame(room);
      break;
    }
 
    // ── In-game: position relay ────────────────────────────────────
    case 'player_update': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      const rp = room.players.get(player.socketId);
      if (!rp) break;
      rp.x = msg.x; rp.y = msg.y; rp.angle = msg.angle;
      rp.hp = msg.hp; rp.armor = msg.armor; rp.dead = msg.dead;
      rp.slotIdx = msg.slotIdx; rp.inv = msg.inv;
      broadcast(room, {
        type    : 'player_update',
        socketId: player.socketId,
        x: msg.x, y: msg.y, angle: msg.angle,
        hp: msg.hp, armor: msg.armor, dead: msg.dead,
        slotIdx: msg.slotIdx, inv: msg.inv,
        skin: rp.skin, hat: rp.hat, face: rp.face,
        team: rp.team, name: rp.name,
      }, ws);
      break;
    }
 
    // ── In-game: bullet relay ──────────────────────────────────────
    case 'bullet_fired': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'bullet_fired',
        socketId: player.socketId,
        x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy,
        dmg: msg.dmg, range: msg.range, r: msg.r,
        expl: msg.expl, color: msg.color,
        flame: msg.flame, laser: msg.laser,
      }, ws);
      break;
    }
 
    case 'explosion': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type: 'explosion', socketId: player.socketId,
        x: msg.x, y: msg.y, radius: msg.radius, damage: msg.damage,
      }, ws);
      break;
    }
 
    // ── In-game: hit a real remote player ─────────────────────────
    case 'hit_player':
    case 'player_hit': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
 
      const targetRp = room.players.get(msg.targetId);
      if (!targetRp || targetRp.dead) break;
 
      // Friendly fire checks
      if (room.mode === 'tdm' && targetRp.team === player.team) break;
      if (room.mode === 'infection') {
        const attackerRp  = room.players.get(player.socketId);
        const attackerTeam = attackerRp
          ? (attackerRp.infTeam !== undefined ? attackerRp.infTeam : attackerRp.team)
          : player.team;
        const victimTeam  = targetRp.infTeam !== undefined ? targetRp.infTeam : targetRp.team;
        if (attackerTeam === victimTeam) break;
      }
 
      const damage   = Math.min(Math.max(Number(msg.damage) || 0, 0), 500);
      const absorbed = targetRp.armor > 0
        ? Math.min(targetRp.armor, Math.round(damage * 0.6)) : 0;
      const hpDamage = damage - absorbed;
      targetRp.armor = Math.max(0, targetRp.armor - absorbed);
      targetRp.hp    = Math.max(0, targetRp.hp    - hpDamage);
 
      const targetWs = wsBySocketId(msg.targetId);
      if (targetWs) {
        send(targetWs, {
          type        : 'you_hit',
          damage, hpDamage, armorDamage: absorbed,
          attackerId  : player.socketId,
          weapon      : msg.weapon || '?',
        });
      }
 
      const killed = targetRp.hp <= 0 && !targetRp.dead;
      send(ws, { type: 'hitmarker', kill: killed });
 
      if (killed) {
        targetRp.dead = true;

        // ── Infection: bullet kill = infect, not eliminate ─────────
        if (room.mode === 'infection') {
          const attackerRp  = room.players.get(player.socketId);
          const attackerTeam = attackerRp
            ? (attackerRp.infTeam !== undefined ? attackerRp.infTeam : attackerRp.team) : 0;
          if (attackerTeam === 1) {
            // Revive victim as infected instead of killing them
            targetRp.dead    = false;
            targetRp.hp      = 80;
            targetRp.infTeam = 1;
            if (targetWs) {
              send(targetWs, {
                type      : 'you_infected',
                killerName: player.name,
              });
            }
            broadcast(room, {
              type     : 'infection_team',
              socketId : msg.targetId,
              team     : 1,
            });
            addGChatRoom(room, `🦠 ${targetRp.name} was infected by ${player.name}!`);
            checkInfectionLastSurvivor(room);
            checkInfectionWin(room);
            // Credit the infector a kill in scores
            const ks = getOrInitScore(room, player.socketId, player.name);
            ks.k++; ks.score += 100;
            send(ws, { type: 'kill_confirmed', victimName: targetRp.name, weapon: msg.weapon || '?' });
            broadcast(room, {
              type: 'kill_event',
              killerId: player.socketId, killerName: player.name,
              victimId: msg.targetId,   victimName: targetRp.name,
              weapon: msg.weapon || '?', scores: room.scores,
            });
            break;
          }
        }

        const ks = getOrInitScore(room, player.socketId, player.name);
        ks.k++; ks.score += 100; ks.name = player.name;
 
        const vs = getOrInitScore(room, msg.targetId, targetRp.name);
        vs.d++; vs.name = targetRp.name;
 
        const killerRp = room.players.get(player.socketId);
        if (killerRp) killerRp.kills = (killerRp.kills || 0) + 1;
        targetRp.deaths = (targetRp.deaths || 0) + 1;
 
        if (targetWs) {
          send(targetWs, {
            type: 'you_died', killerId: player.socketId,
            killerName: player.name, weapon: msg.weapon || '?',
          });
        }
        send(ws, { type: 'kill_confirmed', victimName: targetRp.name, weapon: msg.weapon || '?' });
        broadcast(room, {
          type: 'kill_event',
          killerId: player.socketId, killerName: player.name,
          victimId: msg.targetId,   victimName: targetRp.name,
          weapon: msg.weapon || '?', scores: room.scores,
        });

        if (room.mode === 'infection') checkInfectionLastSurvivor(room);
        checkWin(room);
      }
      break;
    }
 
    // ── NPC kill / self-death ──────────────────────────────────────
    case 'player_killed': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
 
      const ks = getOrInitScore(room, player.socketId, player.name);
      ks.k++; ks.score += 100; ks.name = player.name;
      const killerRp = room.players.get(player.socketId);
      if (killerRp) killerRp.kills = (killerRp.kills || 0) + 1;
 
      const victimRp = msg.victimId ? room.players.get(msg.victimId) : null;
      if (victimRp && !victimRp.dead) {
        victimRp.dead   = true;
        victimRp.deaths = (victimRp.deaths || 0) + 1;
        const vs = getOrInitScore(room, msg.victimId, victimRp.name);
        vs.d++; vs.name = victimRp.name;
        const victimWs = wsBySocketId(msg.victimId);
        if (victimWs) {
          send(victimWs, {
            type: 'you_died', killerId: player.socketId,
            killerName: player.name, weapon: msg.weapon || '?',
          });
        }
      }
 
      send(ws, { type: 'kill_confirmed', victimName: msg.victimName || '???', weapon: msg.weapon || '?' });
      broadcast(room, {
        type: 'kill_event',
        killerId: player.socketId, killerName: player.name,
        victimId: msg.victimId || null, victimName: msg.victimName || '???',
        weapon: msg.weapon || '?', scores: room.scores,
      });
 
      checkWin(room);
      break;
    }
 
    case 'game_chat': {
      const room = getPlayerRoom(player);
      if (!room) break;
      broadcast(room, { type: 'game_chat', name: player.name, text: String(msg.text || '').slice(0, 120) });
      break;
    }
 
    case 'streak_used': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type: 'streak_used', socketId: player.socketId,
        streak: msg.streak, x: msg.x, y: msg.y,
      }, ws);
      break;
    }
 
    case 'weapon_pickup': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, { type: 'weapon_pickup', socketId: player.socketId, spawnIdx: msg.spawnIdx }, ws);
      break;
    }
 
    case 'ping':
      player.pingTs = Date.now();
      send(ws, { type: 'pong', ts: msg.ts });
      break;
 
    case 'host_map_vote': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'lobby') break;
      if (room.hostId !== player.socketId) {
        send(ws, { type: 'error', msg: 'Only the host can change the map.' });
        break;
      }
      const validMap = ['city','forest'].includes(msg.map) ? msg.map : 'city';
      room.map = validMap;
      broadcast(room, { type: 'lobby_chat', name: 'SERVER', text: `Host changed map to: ${validMap.toUpperCase()}` });
      broadcast(room, { type: 'map_changed', map: validMap });
      break;
    }
 
    case 'rematch_vote': {
      const room = getPlayerRoom(player);
      if (!room) break;
      if (msg.yes) room.rematchVotes.add(player.socketId);
      else room.rematchVotes.delete(player.socketId);
      const total = room.players.size;
      const yes   = room.rematchVotes.size;
      broadcast(room, { type: 'rematch_vote_update', yes, total });
      if (yes >= Math.ceil(total / 2) && (room.state === 'lobby' || room.state === 'gameover')) {
        room.rematchVotes.clear();
        setTimeout(() => startGame(room), 2000);
      }
      break;
    }
 
    case 'kick_player': {
      const room = getPlayerRoom(player);
      if (!room) break;
      if (room.hostId !== player.socketId) {
        send(ws, { type: 'error', msg: 'Only the host can kick players.' });
        break;
      }
      const targetWs = wsBySocketId(msg.targetId);
      if (targetWs) {
        send(targetWs, { type: 'kick' });
        leaveRoom(targetWs);
        broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
      }
      break;
    }
 
    case 'gungame_advance': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, { type: 'gungame_advance', socketId: player.socketId, slot: msg.slot }, ws);
      const rp = room.players.get(player.socketId);
      if (rp) rp.ggSlot = msg.slot;
      if (msg.slot >= 22) endGame(room, player.name, player.socketId);
      break;
    }
 
    case 'smoke_cloud': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, { type: 'smoke_cloud', socketId: player.socketId, x: msg.x, y: msg.y }, ws);
      break;
    }
 
    case 'taunt': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type: 'taunt', socketId: player.socketId,
        emoji: String(msg.emoji || '💀').slice(0, 4),
      }, ws);
      break;
    }
 
    case 'speed_boost': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, { type: 'speed_boost', socketId: player.socketId }, ws);
      break;
    }
 
    case 'player_respawned': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      const rp = room.players.get(player.socketId);
      if (rp) {
        rp.dead = false; rp.hp = 100; rp.armor = 0; rp.piercingTimer = 0;
        if (msg.x !== undefined) rp.x = msg.x;
        if (msg.y !== undefined) rp.y = msg.y;
        // In infection mode, reviving a survivor restores their survivor team
        if (room.mode === 'infection' && rp.infTeam === undefined) rp.infTeam = 0;
      }
      broadcast(room, { type: 'player_respawned', socketId: player.socketId, x: msg.x, y: msg.y }, ws);
      break;
    }
 
    case 'uav_scan': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, { type: 'uav_scan', socketId: player.socketId }, ws);
      break;
    }
 
    case 'vote_kick_start': {
      const room = getPlayerRoom(player);
      if (!room) break;
      const targetName = String(msg.targetName || '').toLowerCase().slice(0, 24);
      if (!room.voteKick || room.voteKick.targetName !== targetName) {
        room.voteKick = { targetName, votes: new Set(), startTime: Date.now() };
      }
      room.voteKick.votes.add(player.socketId);
      const votes = room.voteKick.votes.size;
      const total = room.players.size;
      broadcast(room, { type: 'vote_kick_update', targetName, votes, total });
      if (votes >= Math.ceil(total / 2)) {
        let kicked = false;
        room.players.forEach((rp, sid) => {
          if (rp.name.toLowerCase() === targetName && sid !== player.socketId) {
            const targetWs = wsBySocketId(sid);
            if (targetWs) { send(targetWs, { type: 'kick' }); leaveRoom(targetWs); kicked = true; }
          }
        });
        if (kicked) broadcast(room, { type: 'lobby_chat', name: 'SERVER', text: `${targetName} was vote-kicked.` });
        room.voteKick = null;
      }
      break;
    }

    case 'vote_kick_result': break;
 
    case 'piercing_pickup': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      const rp = room.players.get(player.socketId);
      if (rp) rp.piercingTimer = 30;
      broadcast(room, { type: 'piercing_pickup', socketId: player.socketId, duration: 30 }, ws);
      break;
    }
 
    case 'sticky_bomb': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type: 'sticky_bomb', socketId: player.socketId,
        x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy,
      }, ws);
      break;
    }
 
    // ── Infection team sync ────────────────────────────────────────
    case 'infection_team': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame' || room.mode !== 'infection') break;
      const rp = room.players.get(player.socketId);
      if (rp) rp.infTeam = msg.team === 1 ? 1 : 0;
      player.infTeam = msg.team === 1 ? 1 : 0;
      broadcast(room, {
        type    : 'infection_team',
        socketId: player.socketId,
        team    : rp ? rp.infTeam : 0,
      });
      checkInfectionLastSurvivor(room);
      checkInfectionWin(room);
      break;
    }

    // ── KOTH: client reports position (handled via player_update) ──
    // Server computes capture from rp.x/rp.y — no separate message needed.
    // Keep this stub for legacy clients that still send koth_points.
    case 'koth_points':
      break;
 
    default:
      break;
  }
}

// ─── Infection helpers ───────────────────────────────────────────────
function addGChatRoom(room, text) {
  broadcast(room, { type: 'game_chat', name: 'SERVER', text });
}

function checkInfectionWin(room) {
  if (room.mode !== 'infection' || room.state !== 'ingame') return;
  let survivors = 0;
  room.players.forEach(rp => {
    const team = rp.infTeam !== undefined ? rp.infTeam : rp.team;
    if (!rp.dead && team === 0) survivors++;
  });
  if (survivors === 0) endGame(room, 'INFECTED WIN', null);
}
 
function checkInfectionLastSurvivor(room) {
  if (room.mode !== 'infection' || room.state !== 'ingame') return;
  const survivors = [];
  room.players.forEach((rp, sid) => {
    const team = rp.infTeam !== undefined ? rp.infTeam : rp.team;
    if (!rp.dead && team === 0) survivors.push({ sid, rp });
  });
  if (survivors.length === 1) {
    const { sid, rp } = survivors[0];
    broadcast(room, { type: 'infection_last_survivor', socketId: sid, name: rp.name, x: rp.x, y: rp.y });
  } else {
    broadcast(room, { type: 'infection_last_survivor', socketId: null });
  }
}
 
function joinRoom(ws, roomId, info = {}) {
  const player = players.get(ws);
  if (!player) return;
  if (player.roomId) leaveRoom(ws);
 
  const room = rooms.get(roomId);
  if (!room)                                 return send(ws, { type: 'error', msg: 'Room not found' });
  if (room.players.size >= MAX_ROOM_PLAYERS) return send(ws, { type: 'error', msg: 'Room is full' });
  if (room.state === 'gameover')             return send(ws, { type: 'error', msg: 'Game already ended' });
  if (room.locked && room.isPrivate && player.socketId !== room.hostId) {
    if (room.password && (info || {}).password !== room.password)
      return send(ws, { type: 'error', msg: 'Wrong password — room is private' });
    if (!room.password)
      return send(ws, { type: 'error', msg: 'Room is private — invite only' });
  }
 
  applyPlayerInfo(player, info || {});
  player.roomId = roomId;
  player.ready  = false;
  player.kills  = 0;
  player.deaths = 0;
  player.hp     = 100;
  player.armor  = 0;
  player.dead   = false;
 
  if (room.players.size === 0) room.hostId = player.socketId;
 
  if (room.mode === 'tdm') {
    const count = { 0: 0, 1: 0 };
    room.players.forEach(p => { count[p.team] = (count[p.team] || 0) + 1; });
    player.team = count[0] <= count[1] ? 0 : 1;
  }
 
  const rp = {
    socketId: player.socketId,
    name    : player.name, skin: player.skin,
    hat     : player.hat,  face: player.face,
    ready   : false, kills: 0, deaths: 0,
    team    : player.team,
    infTeam : 0,
    x: 2500, y: 2500, angle: 0,
    hp: 100, armor: 0, dead: false,
    slotIdx: 0, inv: [],
    piercingTimer: 0,
  };
  room.players.set(player.socketId, rp);
  room.scores[player.socketId] = { k: 0, d: 0, score: 0, name: player.name };
 
  send(ws, {
    type: 'joined_room',
    roomId: room.id, roomName: room.name, mode: room.mode, map: room.map,
    state: room.state, locked: !!room.locked,
    socketId: player.socketId, hostId: room.hostId,
    players: getLobbyPlayers(room), scores: room.scores,
  });
 
  broadcast(room, {
    type: 'player_joined',
    player : { socketId: player.socketId, name: player.name, skin: player.skin, hat: player.hat, face: player.face },
    players: getLobbyPlayers(room),
  }, ws);
 
  if (room.state === 'ingame') {
    send(ws, { type: 'game_start', mode: room.mode, map: room.map, scoreLimit: room.scoreLimit, scores: room.scores, hostId: room.hostId });
    // Send current KOTH state if applicable
    if (room.mode === 'koth' && room.koth) {
      send(ws, { type: 'koth_sync', koth: serializeKOTH(room.koth) });
    }
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
  broadcast(room, { type: 'player_left', socketId: player.socketId, name: player.name, players: getLobbyPlayers(room) });
  if (room.players.size === 0 && room.startTimer) {
    clearInterval(room.startTimer);
    room.startTimer = null;
  }
}
 
function handleDisconnect(ws) {
  leaveRoom(ws);
  players.delete(ws);
}
 
// ─── Game flow ──────────────────────────────────────────────────────
function checkAutoStart(room) {
  if (room.state !== 'lobby' || room.players.size < 2) return;
  let allReady = true;
  room.players.forEach(p => { if (!p.ready) allReady = false; });
  if (allReady) startCountdown(room);
}
 
function startCountdown(room) {
  if (room.startTimer) return;
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
  room.state  = 'ingame';
  room.locked = true;
  room.scores = {};
  room.players.forEach((p, sid) => {
    p.kills = 0; p.deaths = 0; p.hp = 100; p.armor = 0; p.dead = false;
    p.infTeam = 0;  // reset infection team — everyone starts as survivor
    room.scores[sid] = { k: 0, d: 0, score: 0, name: p.name };
  });
  // Init KOTH state server-side
  if (room.mode === 'koth') initKOTH(room);
  // Init infection state
  if (room.mode === 'infection') {
    room.infState = { phase: 'running', timeLeft: 180, firstInfectedId: null };
  }
  broadcast(room, {
    type: 'game_start',
    mode: room.mode, map: room.map, scoreLimit: room.scoreLimit,
    scores: room.scores, players: getLobbyPlayers(room), hostId: room.hostId,
  });
  // Send initial KOTH state
  if (room.mode === 'koth') {
    broadcast(room, { type: 'koth_sync', koth: serializeKOTH(room.koth) });
  }
}
 
function checkWin(room) {
  if (room.state !== 'ingame') return;
  if (room.mode === 'koth' || room.mode === 'infection') return; // managed separately
  if (room.mode === 'gungame') {
    Object.entries(room.scores).forEach(([sid, s]) => {
      if (s.k >= room.scoreLimit) {
        const wp = room.players.get(sid);
        endGame(room, wp ? wp.name : 'Unknown', sid);
      }
    });
    return;
  }
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
    // TDM
    const team = { 0: 0, 1: 0 };
    Object.entries(room.scores).forEach(([sid, s]) => {
      const p = room.players.get(sid);
      if (p) team[p.team] = (team[p.team] || 0) + s.k;
    });
    if      (team[0] >= room.scoreLimit) endGame(room, 'BLUE TEAM', null);
    else if (team[1] >= room.scoreLimit) endGame(room, 'RED TEAM',  null);
  }
}
 
function broadcastRoomListToAll() {
  const list = getRoomList();
  players.forEach((p, ws) => { if (!p.roomId) send(ws, { type: 'room_list', rooms: list }); });
}
 
function endGame(room, winnerName, winnerSocketId) {
  if (room.state !== 'ingame') return;
  room.state = 'gameover';
  broadcast(room, {
    type: 'game_over', winnerName,
    winnerSocketId: winnerSocketId || null,
    scores: room.scores, players: getLobbyPlayers(room),
  });
  broadcastRoomListToAll();
  setTimeout(() => {
    if (room.players.size === 0) {
      rooms.delete(room.id);
    } else {
      room.state  = 'lobby';
      room.locked = !!room.isPrivate;
      room.scores = {};
      room.koth   = null;
      room.infState = { phase: 'lobby', timeLeft: 180, firstInfectedId: null };
      room.rematchVotes = new Set();
      room.players.forEach((p, sid) => {
        p.ready = false; p.kills = 0; p.deaths = 0;
        p.hp = 100; p.armor = 0; p.dead = false;
        p.ggSlot = 0; p.infTeam = 0;
        room.scores[sid] = { k: 0, d: 0, score: 0, name: p.name };
      });
      if (!room.players.has(room.hostId)) {
        room.hostId = room.players.keys().next().value || null;
      }
      broadcast(room, { type: 'rematch_lobby', players: getLobbyPlayers(room), hostId: room.hostId });
      broadcastRoomListToAll();
    }
  }, 15_000);
}

// ─── Serialize KOTH state for client ─────────────────────────────────
function serializeKOTH(k) {
  return {
    zones     : k.zones.map(z => ({
      x: z.x, y: z.y, r: z.r, label: z.label,
      captureProgress: z.captureProgress,
      captured: z.captured,
    })),
    hillIdx   : k.hillIdx,
    hillTimer : k.hillTimer,
    teamScores: k.teamScores,
    scores    : k.scores,
  };
}
 
// ─── World snapshot + KOTH tick (20 Hz) ──────────────────────────────
let _lastTickTime = Date.now();
setInterval(() => {
  const now = Date.now();
  const dtSec = Math.min((now - _lastTickTime) / 1000, 0.1);
  _lastTickTime = now;

  rooms.forEach(room => {
    if (room.state !== 'ingame') return;

    // KOTH server tick
    if (room.mode === 'koth' && room.koth) {
      tickKOTH(room, dtSec);
      // Broadcast authoritative KOTH state every tick
      if (room.koth) {
        broadcast(room, { type: 'koth_sync', koth: serializeKOTH(room.koth) });
      }
    }

    // Infection timer tick
    if (room.mode === 'infection' && room.infState.phase === 'running') {
      room.infState.timeLeft -= dtSec;
      if (room.infState.timeLeft <= 0) {
        room.infState.phase = 'over';
        // Survivors win if any remain
        let survivors = 0;
        let lastSurvivorName = 'SURVIVORS';
        room.players.forEach(rp => {
          const team = rp.infTeam !== undefined ? rp.infTeam : rp.team;
          if (!rp.dead && team === 0) { survivors++; lastSurvivorName = rp.name; }
        });
        endGame(room, survivors > 0 ? 'SURVIVORS WIN' : 'INFECTED WIN', null);
      } else {
        // Broadcast infection timer to all clients every tick
        broadcast(room, { type: 'infection_tick', timeLeft: room.infState.timeLeft });
        // Refresh last-survivor pin
        if (room.infState.phase === 'running') checkInfectionLastSurvivor(room);
      }
    }

    // World snapshot
    const snapshot = [];
    room.players.forEach((p, sid) => {
      if (p.piercingTimer > 0) p.piercingTimer = Math.max(0, p.piercingTimer - dtSec);
      snapshot.push({
        socketId: sid, name: p.name, skin: p.skin, hat: p.hat, face: p.face,
        team: p.team, infTeam: p.infTeam,
        x: p.x, y: p.y, angle: p.angle,
        hp: p.hp, armor: p.armor, dead: p.dead, kills: p.kills,
        piercingTimer: p.piercingTimer,
      });
    });
    broadcast(room, { type: 'world_snapshot', players: snapshot, scores: room.scores });
  });
}, TICK_MS);
 
// ─── Start ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Slime Wars server on port ${PORT}`);
});
