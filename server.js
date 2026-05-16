'use strict';

const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT             = process.env.PORT || 3000;
const MAX_ROOM_PLAYERS = 12;
const TICK_MS          = 50;   // 20 Hz world snapshots

// ─── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) =>
  res.json({ ok: true, rooms: rooms.size, players: players.size }));

// ─── In-memory state ───────────────────────────────────────────────
const rooms   = new Map();   // roomId  → Room
const players = new Map();   // ws      → Player

// ─── Room factory ──────────────────────────────────────────────────
function createRoom(name, mode, map) {
  const id = uuidv4().slice(0, 8).toUpperCase();
  const validMode = ['ffa','tdm','gungame'].includes(mode) ? mode : 'ffa';
  const validMap  = ['city','forest'].includes(map) ? map : 'city';
  const room = {
    id,
    name      : name || `SLIME-${id}`,
    mode      : validMode,
    map       : validMap,
    state     : 'lobby',        // lobby | ingame | gameover
    players   : new Map(),      // socketId → roomPlayer
    scores    : {},
    scoreLimit: validMode === 'tdm' ? 50 : validMode === 'gungame' ? 22 : 30,
    startTimer: null,
    createdAt : Date.now(),
    rematchVotes: new Set(),    // socketIds that voted yes
    hostId    : null,           // first player to join is host
  };
  rooms.set(id, room);
  return room;
}

// ─── Helpers ───────────────────────────────────────────────────────
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
    if (r.state !== 'gameover') {
      list.push({
        id         : r.id,
        name       : r.name,
        mode       : r.mode,
        players    : r.players.size,
        max        : MAX_ROOM_PLAYERS,
        state      : r.state,
        locked     : !!r.locked,
        isPrivate  : !!r.isPrivate,
        ping       : Math.floor(Math.random() * 40) + 5,
      });
    }
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

// ─── Default public rooms ──────────────────────────────────────────
function ensurePublicRooms() {
  let lobbies = 0;
  rooms.forEach(r => { if (r.state === 'lobby') lobbies++; });
  if (lobbies < 3) {
    createRoom('SLIMEVILLE', 'ffa');
    createRoom('GOO CANYON',  'tdm');
    createRoom('GUN GAME ARENA', 'gungame');
  }
}
ensurePublicRooms();

setInterval(() => {
  rooms.forEach((r, id) => {
    if (r.players.size === 0 && r.state === 'gameover') rooms.delete(id);
  });
  ensurePublicRooms();
}, 60_000);

// ─── Connection ────────────────────────────────────────────────────
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

// ─── Message router ────────────────────────────────────────────────
function handleMessage(ws, msg) {
  const player = players.get(ws);
  if (!player) return;

  switch (msg.type) {

    // ── Room browsing ─────────────────────────────────────────────
    case 'get_rooms':
      send(ws, { type: 'room_list', rooms: getRoomList() });
      break;

    case 'create_room': {
      const room = createRoom(msg.name, msg.mode, msg.map);
      room.hostId = player.socketId;
      // Private / locked room: only the host (and invited players) can join
      if (msg.locked) {
        room.locked    = true;
        room.password  = msg.password ? String(msg.password).slice(0, 32) : null;
        room.isPrivate = true;   // stays locked even in lobby (not just in-game)
      }
      joinRoom(ws, room.id, msg.playerInfo);
      break;
    }

    case 'join_room':
      joinRoom(ws, msg.roomId, msg.playerInfo);
      break;

    // Client sends: { type:'quick_join', playerInfo:{...} }
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

    // ── Lobby ─────────────────────────────────────────────────────
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

    // Client sends: { type:'set_ready', ready:bool }
    case 'set_ready': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'lobby') break;
      const rp = room.players.get(player.socketId);
      if (rp) rp.ready = !!msg.ready;
      broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
      checkAutoStart(room);
      break;
    }

    // Client sends: { type:'lobby_chat', text:str }
    case 'lobby_chat': {
      const room = getPlayerRoom(player);
      if (!room) break;
      const text = String(msg.text || '').slice(0, 120);
      // Slash commands
      if (text.startsWith('/kick ') && room.hostId === player.socketId) {
        const targetName = text.slice(6).trim().toLowerCase();
        let kicked = false;
        room.players.forEach((rp, sid) => {
          if (rp.name.toLowerCase() === targetName && sid !== player.socketId) {
            const targetWs = wsBySocketId(sid);
            if (targetWs) {
              send(targetWs, { type: 'kick' });
              leaveRoom(targetWs);
              kicked = true;
            }
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
      broadcast(room, {
        type: 'lobby_chat',
        name: player.name,
        text,
      });
      break;
    }

    case 'set_mode':
      send(ws, { type: 'error', msg: 'Game mode is locked.' });
      break;

    case 'force_start': {
      const room = getPlayerRoom(player);
      if (room && room.state === 'lobby') startGame(room);
      break;
    }

    // ── In-game: position relay ────────────────────────────────────
    // Client sends every ~2 frames: { type:'player_update', x,y,angle,hp,armor,dead,slotIdx,inv }
    case 'player_update': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      const rp = room.players.get(player.socketId);
      if (!rp) break;

      rp.x      = msg.x;
      rp.y      = msg.y;
      rp.angle  = msg.angle;
      rp.hp     = msg.hp;
      rp.armor  = msg.armor;
      rp.dead   = msg.dead;
      rp.slotIdx = msg.slotIdx;
      rp.inv    = msg.inv;

      // Relay with skin/hat/face/name so late-joiners render correctly
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

    // ── In-game: bullet relay ─────────────────────────────────────
    // Client sends: { type:'bullet_fired', x,y,vx,vy,dmg,range,r,expl,color,flame,laser }
    case 'bullet_fired': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'bullet_fired',
        socketId: player.socketId,
        x: msg.x,   y: msg.y,
        vx: msg.vx, vy: msg.vy,
        dmg  : msg.dmg,
        range: msg.range,
        r    : msg.r,
        expl : msg.expl,
        color: msg.color,
        flame: msg.flame,
        laser: msg.laser,
      }, ws);
      break;
    }

    // ── In-game: explosion relay ──────────────────────────────────
    case 'explosion': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'explosion',
        socketId: player.socketId,
        x: msg.x, y: msg.y,
        radius: msg.radius,
        damage: msg.damage,
      }, ws);
      break;
    }

    // ── In-game: hit a real remote player (bullet OR explosion) ───
    // Client sends: { type:'hit_player', targetId, damage, weapon }
    case 'hit_player':
    case 'player_hit': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;

      const targetRp = room.players.get(msg.targetId);
      if (!targetRp || targetRp.dead) break;

      const damage   = Math.min(Math.max(Number(msg.damage) || 0, 0), 500);
      const absorbed = targetRp.armor > 0
        ? Math.min(targetRp.armor, Math.round(damage * 0.4)) : 0;
      targetRp.armor = Math.max(0, targetRp.armor - absorbed);
      targetRp.hp    = Math.max(0, targetRp.hp   - (damage - absorbed));

      const targetWs = wsBySocketId(msg.targetId);
      if (targetWs) {
        send(targetWs, {
          type      : 'you_hit',
          damage,
          attackerId: player.socketId,
          weapon    : msg.weapon || '?',
        });
      }

      const killed = targetRp.hp <= 0 && !targetRp.dead;
      send(ws, { type: 'hitmarker', kill: killed });

      if (killed) {
        targetRp.dead = true;

        const ks = getOrInitScore(room, player.socketId, player.name);
        ks.k++; ks.score += 100; ks.name = player.name;

        const vs = getOrInitScore(room, msg.targetId, targetRp.name);
        vs.d++; vs.name = targetRp.name;

        const killerRp = room.players.get(player.socketId);
        if (killerRp) killerRp.kills = (killerRp.kills || 0) + 1;
        targetRp.deaths = (targetRp.deaths || 0) + 1;

        if (targetWs) {
          send(targetWs, {
            type      : 'you_died',
            killerId  : player.socketId,
            killerName: player.name,
            weapon    : msg.weapon || '?',
          });
        }

        // Confirm kill to attacker → client ticks streaks + nuke counter
        send(ws, {
          type      : 'kill_confirmed',
          victimName: targetRp.name,
          weapon    : msg.weapon || '?',
        });

        broadcast(room, {
          type      : 'kill_event',
          killerId  : player.socketId,
          killerName: player.name,
          victimId  : msg.targetId,
          victimName: targetRp.name,
          weapon    : msg.weapon || '?',
          scores    : room.scores,
        });

        checkWin(room);
      }
      break;
    }

    // ── In-game: NPC kill (or self-death) reported by client ──────
    // Client sends: { type:'player_killed', victimId, victimName, weapon }
    // victimId is null for NPC kills; non-null for another real player
    case 'player_killed': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;

      // Credit the kill to the sender
      const ks = getOrInitScore(room, player.socketId, player.name);
      ks.k++; ks.score += 100; ks.name = player.name;
      const killerRp = room.players.get(player.socketId);
      if (killerRp) killerRp.kills = (killerRp.kills || 0) + 1;

      // If victim is a real room player (can happen via NPC proxy collision)
      const victimRp = msg.victimId ? room.players.get(msg.victimId) : null;
      if (victimRp && !victimRp.dead) {
        victimRp.dead   = true;
        victimRp.deaths = (victimRp.deaths || 0) + 1;
        const vs = getOrInitScore(room, msg.victimId, victimRp.name);
        vs.d++; vs.name = victimRp.name;
        const victimWs = wsBySocketId(msg.victimId);
        if (victimWs) {
          send(victimWs, {
            type      : 'you_died',
            killerId  : player.socketId,
            killerName: player.name,
            weapon    : msg.weapon || '?',
          });
        }
      }

      // Confirm kill back → client ticks streaks
      send(ws, {
        type      : 'kill_confirmed',
        victimName: msg.victimName || '???',
        weapon    : msg.weapon || '?',
      });

      broadcast(room, {
        type      : 'kill_event',
        killerId  : player.socketId,
        killerName: player.name,
        victimId  : msg.victimId || null,
        victimName: msg.victimName || '???',
        weapon    : msg.weapon || '?',
        scores    : room.scores,
      });

      checkWin(room);
      break;
    }

    // ── In-game: chat ─────────────────────────────────────────────
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

    // ── In-game: scorestreak visual broadcast ─────────────────────
    // Client sends: { type:'streak_used', streak, x, y }
    case 'streak_used': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'streak_used',
        socketId: player.socketId,
        streak  : msg.streak,
        x       : msg.x,
        y       : msg.y,
      }, ws);
      break;
    }

    // ── In-game: weapon pickup sync ───────────────────────────────
    // Client sends: { type:'weapon_pickup', spawnIdx }
    case 'weapon_pickup': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'weapon_pickup',
        socketId: player.socketId,
        spawnIdx: msg.spawnIdx,
      }, ws);
      break;
    }

    // ── Ping / pong ───────────────────────────────────────────────
    case 'ping':
      player.pingTs = Date.now();
      send(ws, { type: 'pong', ts: msg.ts });
      break;

    // ── Rematch vote ──────────────────────────────────────────────
    case 'rematch_vote': {
      const room = getPlayerRoom(player);
      if (!room) break;
      if (msg.yes) room.rematchVotes.add(player.socketId);
      else room.rematchVotes.delete(player.socketId);
      const total = room.players.size;
      const yes = room.rematchVotes.size;
      broadcast(room, { type: 'rematch_vote_update', yes, total });
      // Auto-start rematch if majority votes yes
      if (yes >= Math.ceil(total / 2) && (room.state === 'lobby' || room.state === 'gameover')) {
        room.rematchVotes.clear();
        setTimeout(() => startGame(room), 2000);
      }
      break;
    }

    // ── Kick player (host only) ───────────────────────────────────
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
        const targetPlayer = players.get(targetWs);
        if (targetPlayer) {
          leaveRoom(targetWs);
          broadcast(room, { type: 'lobby_players', players: getLobbyPlayers(room) });
        }
      }
      break;
    }

    // ── Gun Game advance relay ────────────────────────────────────
    case 'gungame_advance': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'gungame_advance',
        socketId: player.socketId,
        slot    : msg.slot,
      }, ws);
      // Check for gun game win (all weapons cycled)
      const rp = room.players.get(player.socketId);
      if (rp) rp.ggSlot = msg.slot;
      if (msg.slot >= 22) { // GUN_GAME_ORDER.length
        endGame(room, player.name, player.socketId);
      }
      break;
    }

    // ── Smoke cloud relay ────────────────────────────────────────
    case 'smoke_cloud': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'smoke_cloud',
        socketId: player.socketId,
        x       : msg.x,
        y       : msg.y,
      }, ws);
      break;
    }

    // ── Taunt relay ───────────────────────────────────────────────
    case 'taunt': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'taunt',
        socketId: player.socketId,
        emoji   : String(msg.emoji || '💀').slice(0, 4),
      }, ws);
      break;
    }

    // ── Speed-pad trigger (informational relay) ───────────────────
    case 'speed_boost': {
      const room = getPlayerRoom(player);
      if (!room || room.state !== 'ingame') break;
      broadcast(room, {
        type    : 'speed_boost',
        socketId: player.socketId,
      }, ws);
      break;
    }

    default:
      break;
  }
}

// ─── Join / Leave ──────────────────────────────────────────────────
function joinRoom(ws, roomId, info = {}) {
  const player = players.get(ws);
  if (!player) return;
  if (player.roomId) leaveRoom(ws);

  const room = rooms.get(roomId);
  if (!room)                                 return send(ws, { type: 'error', msg: 'Room not found' });
  if (room.players.size >= MAX_ROOM_PLAYERS) return send(ws, { type: 'error', msg: 'Room is full' });
  if (room.state === 'gameover')             return send(ws, { type: 'error', msg: 'Game already ended' });
  if (room.state === 'ingame' && room.locked && !room.isPrivate) return send(ws, { type: 'error', msg: 'Room is locked — game in progress' });
  // Private rooms: block all joins unless correct password supplied (host is already inside)
  if (room.isPrivate && player.socketId !== room.hostId) {
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

  // Set host if room is empty
  if (room.players.size === 0) room.hostId = player.socketId;

  // TDM: auto-balance teams
  if (room.mode === 'tdm') {
    const count = { 0: 0, 1: 0 };
    room.players.forEach(p => { count[p.team] = (count[p.team] || 0) + 1; });
    player.team = count[0] <= count[1] ? 0 : 1;
  }

  const rp = {
    socketId: player.socketId,
    name    : player.name,
    skin    : player.skin,
    hat     : player.hat,
    face    : player.face,
    ready   : false,
    kills   : 0,
    deaths  : 0,
    team    : player.team,
    x: 2500, y: 2500, angle: 0,
    hp: 100, armor: 0, dead: false,
    slotIdx: 0, inv: [],
  };
  room.players.set(player.socketId, rp);
  room.scores[player.socketId] = { k: 0, d: 0, score: 0, name: player.name };

  send(ws, {
    type       : 'joined_room',
    roomId     : room.id,
    roomName   : room.name,
    mode       : room.mode,
    map        : room.map,
    state      : room.state,
    locked     : !!room.locked,
    socketId   : player.socketId,
    hostId     : room.hostId,
    players    : getLobbyPlayers(room),
    scores     : room.scores,
  });

  broadcast(room, {
    type   : 'player_joined',
    player : { socketId: player.socketId, name: player.name, skin: player.skin, hat: player.hat, face: player.face },
    players: getLobbyPlayers(room),
  }, ws);

  // Mid-game join: send game_start so the client starts immediately
  if (room.state === 'ingame') {
    send(ws, { type: 'game_start', mode: room.mode, map: room.map, scoreLimit: room.scoreLimit, scores: room.scores });
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
    type    : 'player_left',
    socketId: player.socketId,
    name    : player.name,
    players : getLobbyPlayers(room),
  });

  if (room.players.size === 0 && room.startTimer) {
    clearInterval(room.startTimer);
    room.startTimer = null;
  }
}

function handleDisconnect(ws) {
  leaveRoom(ws);
  players.delete(ws);
}

// ─── Game flow ─────────────────────────────────────────────────────
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
  room.locked = true;   // lock to prevent late-joins
  room.scores = {};
  room.players.forEach((p, sid) => {
    p.kills = 0; p.deaths = 0; p.hp = 100; p.armor = 0; p.dead = false;
    room.scores[sid] = { k: 0, d: 0, score: 0, name: p.name };
  });
  broadcast(room, {
    type      : 'game_start',
    mode      : room.mode,
    map       : room.map,
    scoreLimit: room.scoreLimit,
    scores    : room.scores,
    players   : getLobbyPlayers(room),
  });
}

function checkWin(room) {
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
    const team = { 0: 0, 1: 0 };
    Object.entries(room.scores).forEach(([sid, s]) => {
      const p = room.players.get(sid);
      if (p) team[p.team] = (team[p.team] || 0) + s.k;
    });
    if      (team[0] >= room.scoreLimit) endGame(room, 'BLUE TEAM', null);
    else if (team[1] >= room.scoreLimit) endGame(room, 'RED TEAM',  null);
  }
}

function endGame(room, winnerName, winnerSocketId) {
  room.state = 'gameover';
  broadcast(room, {
    type          : 'game_over',
    winnerName,
    winnerSocketId: winnerSocketId || null,
    scores        : room.scores,
    players       : getLobbyPlayers(room),
  });

  setTimeout(() => {
    if (room.players.size === 0) {
      rooms.delete(room.id);
    } else {
      room.state  = 'lobby';
      room.locked = !!room.isPrivate;   // private rooms stay locked; public rooms unlock for rematch
      room.scores = {};
      room.rematchVotes = new Set();
      room.players.forEach((p, sid) => {
        p.ready = false; p.kills = 0; p.deaths = 0;
        p.hp = 100; p.armor = 0; p.dead = false;
        p.ggSlot = 0;
        room.scores[sid] = { k: 0, d: 0, score: 0, name: p.name };
      });
      // Reassign host if original left
      if (!room.players.has(room.hostId)) {
        room.hostId = room.players.keys().next().value || null;
      }
      broadcast(room, { type: 'rematch_lobby', players: getLobbyPlayers(room) });
    }
  }, 15_000);
}

// ─── World snapshot tick (20 Hz) ──────────────────────────────────
setInterval(() => {
  rooms.forEach(room => {
    if (room.state !== 'ingame') return;
    const snapshot = [];
    room.players.forEach((p, sid) => snapshot.push({
      socketId: sid,
      name    : p.name,
      skin    : p.skin,
      hat     : p.hat,
      face    : p.face,
      team    : p.team,
      x: p.x,     y: p.y,    angle: p.angle,
      hp: p.hp,   armor: p.armor, dead: p.dead,
      kills: p.kills,
    }));
    broadcast(room, { type: 'world_snapshot', players: snapshot, scores: room.scores });
  });
}, TICK_MS);

// ─── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Slime Wars server on port ${PORT}`);
});
