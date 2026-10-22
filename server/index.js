const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// --- БЕЗОПАСНАЯ ЗАГРУЗКА КОНФИГА ---
let CFG = null;
const configPath = path.join(__dirname, '..', 'config.json');

try {
  CFG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  // Если файла нет, ставим настройки по умолчанию, чтобы сервер не падал
  CFG = {
    MAP: { w: 600, h: 400 },
    PLAYER_SIZE: 20,
    COIN_SIZE: 12,
    COIN_COUNT: 8,
    COIN_TYPES: null,
    MAX_STEP: 20,
    HEARTBEAT_INTERVAL: 5000,
    INACTIVITY_TIMEOUT: 60000,
    SERVER_PING_INTERVAL: 15000,
    PLAYER_TTL_MS: 86400000,
    SAVE_DEBOUNCE_MS: 500,
    MOVE_MIN_INTERVAL_MS: 20
  };
}
// -----------------------------------

// ---------- типы монет ----------
const DEFAULT_COIN_TYPES = [
  { name: 'бронзовая',  color: '#cd7f32', points: 1, weight: 55 },
  { name: 'серебряная', color: '#c9d1d9', points: 2, weight: 28 },
  { name: 'золотая',    color: '#ffd700', points: 3, weight: 12 },
  { name: 'рубиновая',  color: '#e0115f', points: 5, weight: 5 }
];

const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function normalizeCoinTypes(list) {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_COIN_TYPES;
  return list.map((t, i) => ({
    name: typeof t.name === 'string' && t.name ? t.name.slice(0, 24) : `монета ${i + 1}`,
    color: isHexColor(t.color) ? t.color : '#e6b800',
    points: Math.max(1, Math.trunc(Number(t.points)) || 1),
    weight: Math.max(1, Number(t.weight) || 1)
  }));
}

CFG.COIN_TYPES = normalizeCoinTypes(CFG.COIN_TYPES);

const PORT = process.env.PORT || 8080;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');

const {
  MAP, PLAYER_SIZE, COIN_SIZE, COIN_COUNT, COIN_TYPES, MAX_STEP,
  HEARTBEAT_INTERVAL, INACTIVITY_TIMEOUT, SERVER_PING_INTERVAL,
  PLAYER_TTL_MS, SAVE_DEBOUNCE_MS, MOVE_MIN_INTERVAL_MS
} = CFG;

const COIN_TOTAL_WEIGHT = COIN_TYPES.reduce((sum, t) => sum + t.weight, 0);

let state = { players: {}, coins: [] };

// ---------- утилиты ----------
const rnd = (maxInclusive) => Math.floor(Math.random() * (maxInclusive + 1));
const randomColor = () => '#' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
const randomId = () => crypto.randomBytes(8).toString('hex');
const randomPos = (size) => ({ x: rnd(MAP.w - size), y: rnd(MAP.h - size) });

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = Array.from(cleaned).slice(0, 20).join('');
  return name || null;
}

function pickCoinType() {
  let r = Math.random() * COIN_TOTAL_WEIGHT;
  for (let i = 0; i < COIN_TYPES.length; i++) {
    r -= COIN_TYPES[i].weight;
    if (r < 0) return i;
  }
  return COIN_TYPES.length - 1;
}

function overlaps(a, b, sa, sb) {
  return a.x < b.x + sb && a.x + sa > b.x &&
         a.y < b.y + sb && a.y + sa > b.y;
}

// ignoreOffline: true — призраки не считаются препятствием
function playerFree(x, y, ignoreId = null, ignoreOffline = false) {
  if (x < 0 || y < 0 || x + PLAYER_SIZE > MAP.w || y + PLAYER_SIZE > MAP.h) return false;
  for (const id in state.players) {
    if (id === ignoreId) continue;
    const other = state.players[id];
    if (ignoreOffline && other.online === false) continue;
    if (overlaps({ x, y }, other, PLAYER_SIZE, PLAYER_SIZE)) return false;
  }
  return true;
}

function findFreeSpot(preferred, ignoreId = null) {
  const px = Math.max(0, Math.min(MAP.w - PLAYER_SIZE, Math.round(preferred.x)));
  const py = Math.max(0, Math.min(MAP.h - PLAYER_SIZE, Math.round(preferred.y)));
  if (playerFree(px, py, ignoreId)) return { x: px, y: py };

  const maxR = Math.ceil(Math.max(MAP.w, MAP.h) / PLAYER_SIZE);
  for (let r = 1; r <= maxR; r++) {
    for (let i = -r; i <= r; i++) {
      const ring = [
        [px + i * PLAYER_SIZE, py - r * PLAYER_SIZE], // Верхняя граница кольца
        [px + i * PLAYER_SIZE, py + r * PLAYER_SIZE], // Нижняя граница кольца
        [px - r * PLAYER_SIZE, py + i * PLAYER_SIZE], // Левая граница
        [px + r * PLAYER_SIZE, py + i * PLAYER_SIZE]  // Правая граница
      ];
      for (const [x, y] of ring) {
        if (x < 0 || y < 0 || x + PLAYER_SIZE > MAP.w || y + PLAYER_SIZE > MAP.h) continue;
        if (playerFree(x, y, ignoreId)) return { x, y };
      }
    }
  }
  for (let i = 0; i < 100; i++) {
    const p = randomPos(PLAYER_SIZE);
    if (playerFree(p.x, p.y, ignoreId)) return p;
  }
  return { x: px, y: py };
}

function spawnCoin() {
  for (let i = 0; i < 50; i++) {
    const pos = randomPos(COIN_SIZE);
    let ok = true;
    for (const id in state.players) {
      const pl = state.players[id];
      if (pl.online === false) continue;
      if (overlaps(pos, pl, COIN_SIZE, PLAYER_SIZE)) { ok = false; break; }
    }
    if (ok) { state.coins.push({ id: randomId(), ...pos, type: pickCoinType() }); return; }
  }
  state.coins.push({ id: randomId(), ...randomPos(COIN_SIZE), type: pickCoinType() });
}

// ---------- persist ----------
let saveTimer = null;
let saveDirty = false;

function scheduleSave() {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveDirty) { saveDirty = false; doSave(); }
  }, SAVE_DEBOUNCE_MS);
}

function doSave() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('Ошибка сохранения state:', e.message);
  }
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveDirty) { saveDirty = false; doSave(); }
}

// ---------- загрузка ----------
if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.players = loaded.players || {};
    // монеты из старых сохранений без типа считаем бронзовыми
    state.coins = (Array.isArray(loaded.coins) ? loaded.coins : [])
      .filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.y))
      .map((c) => ({
        id: typeof c.id === 'string' && c.id ? c.id : randomId(),
        x: c.x,
        y: c.y,
        type: Number.isInteger(c.type) && c.type >= 0 && c.type < COIN_TYPES.length ? c.type : 0
      }));
    const now = Date.now();
    for (const id in state.players) {
      const p = state.players[id];
      if (typeof p.name !== 'string' || !p.name) p.name = 'Игрок';
      if (!isHexColor(p.color)) p.color = randomColor();
      p.online = false;
      p.offlineAt = now;
    }
    console.log(`Загружено: ${Object.keys(state.players).length} игроков, ${state.coins.length} монеток`);
  } catch (e) {
    console.error('Ошибка загрузки state:', e.message);
  }
}

while (state.coins.length < COIN_COUNT) spawnCoin();

for (const id in state.players) {
  const p = state.players[id];
  const spot = findFreeSpot(p, id);
  if (spot.x !== p.x || spot.y !== p.y) {
    console.log(`Пересечение при загрузке: ${id} (${p.x},${p.y}) → (${spot.x},${spot.y})`);
    p.x = spot.x; p.y = spot.y;
  }
}
doSave();

// ---------- оффлайн ----------
function setPlayerOffline(sessionId) {
  if (!sessionId || !state.players[sessionId]) return;
  const p = state.players[sessionId];
  if (p.online === false) return;
  p.online = false;
  p.offlineAt = Date.now();
  broadcast({ type: 'offline', id: sessionId });
  scheduleSave();
  console.log(`Оффлайн: ${sessionId}`);
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  const urlPath = (req.url || '/').split('?')[0];
  const relPath = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath = path.resolve(CLIENT_DIR, '.' + relPath);
  const rel = path.relative(CLIENT_DIR, fullPath);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WS ----------
const wss = new WebSocket.Server({ server: httpServer });

function broadcast(msg, except = null) {
  const str = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === WebSocket.OPEN) c.send(str);
  }
}

// ---------- heartbeat ----------
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!ws.isAlive) {
      console.log(`Таймаут heartbeat (sessionId=${ws.sessionId || '?'})`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL);

// ---------- серверный ping ----------
const serverPingInterval = setInterval(() => {
  broadcast({ type: 'ping' });
}, SERVER_PING_INTERVAL);

// ---------- неактивность ----------
const inactivityInterval = setInterval(() => {
  const now = Date.now();
  for (const id in state.players) {
    const p = state.players[id];
    if (p.online && now - p.lastSeen > INACTIVITY_TIMEOUT) {
      setPlayerOffline(id);
    }
  }
}, 10000);

// ---------- очистка мёртвых записей ----------
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const id in state.players) {
    const p = state.players[id];
    if (p.online === false && p.offlineAt && now - p.offlineAt > PLAYER_TTL_MS) {
      let hasSocket = false;
      for (const c of wss.clients) {
        if (c.sessionId === id && c.readyState === WebSocket.OPEN) { hasSocket = true; break; }
      }
      if (!hasSocket) { delete state.players[id]; removed++; }
    }
  }
  if (removed) {
    console.log(`Очищено записей: ${removed}`);
    scheduleSave();
  }
}, 60 * 60 * 1000);

// ---------- shutdown ----------
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`${sig} — сохраняю и закрываю...`);
    clearInterval(heartbeatInterval);
    clearInterval(serverPingInterval);
    clearInterval(inactivityInterval);
    clearInterval(cleanupInterval);
    saveNow();
    wss.close(() => {
      httpServer.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
});

// ---------- подключение ----------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.sessionId = null;
  ws.lastMoveAt = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    ws.isAlive = true;

    if (data.type === 'hello') {
      const reqName = sanitizeName(data.name);
      const reqColor = isHexColor(data.color) ? data.color : null;
      const known = typeof data.sessionId === 'string' && data.sessionId && state.players[data.sessionId];

      if (known) {
        ws.sessionId = data.sessionId;
        const p = state.players[ws.sessionId];
        if (!playerFree(p.x, p.y, ws.sessionId)) {
          const spot = findFreeSpot(p, ws.sessionId);
          console.log(`Пересечение при возвращении: ${ws.sessionId} (${p.x},${p.y}) → (${spot.x},${spot.y})`);
          p.x = spot.x; p.y = spot.y;
        }
        if (reqName) p.name = reqName;
        if (!p.name) p.name = 'Игрок';
        if (reqColor) p.color = reqColor;
        p.online = true;
        p.offlineAt = null;
        p.lastSeen = Date.now();
        console.log(`Реконнект: ${ws.sessionId} (${p.name})`);
      } else {
        ws.sessionId = randomId();
        state.players[ws.sessionId] = {
          ...findFreeSpot(randomPos(PLAYER_SIZE), ws.sessionId),
          name: reqName || 'Игрок',
          color: reqColor || randomColor(),
          score: 0,
          online: true,
          lastSeen: Date.now(),
          offlineAt: null
        };
        console.log(`Новый игрок: ${ws.sessionId} (${state.players[ws.sessionId].name})`);
      }

      ws.send(JSON.stringify({
        type: 'init',
        id: ws.sessionId,
        config: {
          MAP,
          PLAYER_SIZE,
          COIN_SIZE,
          COIN_TYPES,
          MOVE_MIN_INTERVAL_MS
        },
        players: state.players,
        coins: state.coins
      }));

      broadcast({ type: 'join', id: ws.sessionId, player: state.players[ws.sessionId] }, ws);
      scheduleSave();
      return;
    }

    if (!ws.sessionId || !state.players[ws.sessionId]) return;
    const me = state.players[ws.sessionId];
    me.lastSeen = Date.now();
    if (me.online === false) {
      me.online = true;
      me.offlineAt = null;
    }

    if (data.type === 'profile') {
      const name = sanitizeName(data.name);
      const color = isHexColor(data.color) ? data.color : null;
      let changed = false;
      if (name && name !== me.name) { me.name = name; changed = true; }
      if (color && color !== me.color) { me.color = color; changed = true; }
      if (changed) {
        broadcast({ type: 'join', id: ws.sessionId, player: me });
        scheduleSave();
      }
      return;
    }

    if (data.type === 'move') {
      const now = Date.now();
      if (now - ws.lastMoveAt < MOVE_MIN_INTERVAL_MS) return;
      ws.lastMoveAt = now;

      if (!playerFree(me.x, me.y, ws.sessionId, true)) {
        const spot = findFreeSpot(me, ws.sessionId);
        console.log(`Освобождение: ${ws.sessionId} (${me.x},${me.y}) → (${spot.x},${spot.y})`);
        me.x = spot.x; me.y = spot.y;
      }

      const rawDx = Number(data.dx);
      const rawDy = Number(data.dy);
      const sdx = Number.isFinite(rawDx) ? Math.max(-MAX_STEP, Math.min(MAX_STEP, Math.trunc(rawDx))) : 0;
      const sdy = Number.isFinite(rawDy) ? Math.max(-MAX_STEP, Math.min(MAX_STEP, Math.trunc(rawDy))) : 0;

      const nx = Math.max(0, Math.min(MAP.w - PLAYER_SIZE, me.x + sdx));
      const ny = Math.max(0, Math.min(MAP.h - PLAYER_SIZE, me.y + sdy));

      if (playerFree(nx, ny, ws.sessionId, true)) {
        me.x = nx; me.y = ny;
      } else if (sdx !== 0 && playerFree(nx, me.y, ws.sessionId, true)) {
        me.x = nx;
      } else if (sdy !== 0 && playerFree(me.x, ny, ws.sessionId, true)) {
        me.y = ny;
      }

      for (let i = state.coins.length - 1; i >= 0; i--) {
        const c = state.coins[i];
        if (overlaps({ x: me.x, y: me.y }, c, PLAYER_SIZE, COIN_SIZE)) {
          state.coins.splice(i, 1);
          const coinType = COIN_TYPES[c.type] || COIN_TYPES[0];
          me.score += coinType.points;
          spawnCoin();
          console.log(` ${ws.sessionId} +${coinType.points} (${coinType.name}), очки=${me.score}`);
        }
      }

      broadcast({ type: 'state', players: state.players, coins: state.coins });
      scheduleSave();
    }
  });

  ws.on('close', () => {
    if (ws.sessionId && state.players[ws.sessionId]) setPlayerOffline(ws.sessionId);
  });

  ws.on('error', (e) => {
    console.error('WS error:', e.message);
    if (ws.sessionId && state.players[ws.sessionId]) setPlayerOffline(ws.sessionId);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log('State file:', STATE_FILE);
});