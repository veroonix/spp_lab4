const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const CLIENT_DIR = path.join(__dirname, '..', 'client');

// ---------- heartbeat / оффлайн-таймаут ----------
// Пингуем клиентов каждые 5 секунд. Если на пинг нет ответа 5 секунд —
// считаем соединение потерянным и помечаем игрока оффлайн.
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = 5000;

// ---------- неактивность и серверный пинг ----------
// Если игрок не присылал сообщений (move/hello) дольше этого — оффлайн для остальных.
const INACTIVITY_TIMEOUT = 60000;
// Сервер шлёт ping всем клиентам, чтобы соединение не простаивало и клиент не думал, что пропал.
const SERVER_PING_INTERVAL = 15000;

const MAP = { w: 600, h: 400 };
const PLAYER_SIZE = 20;
const COIN_SIZE = 12;
const COIN_COUNT = 8;

let state = {
  players: {},
  coins: []
};

// ---------- утилиты ----------
const rnd = (max) => Math.floor(Math.random() * max);
const randomColor = () =>
  '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
const randomId = () => Math.random().toString(36).substring(2, 11);
const randomPos = (size) => ({ x: rnd(MAP.w - size), y: rnd(MAP.h - size) });

function spawnCoin() {
  state.coins.push({ id: randomId(), ...randomPos(COIN_SIZE) });
}

function overlaps(a, b, sa, sb) {
  return a.x < b.x + sb && a.x + sa > b.x &&
         a.y < b.y + sb && a.y + sa > b.y;
}

// свободна ли точка для игрока (не пересекается ни с одним игроком, кроме ignoreId)
function playerFree(x, y, ignoreId = null) {
  if (x < 0 || y < 0 || x + PLAYER_SIZE > MAP.w || y + PLAYER_SIZE > MAP.h) return false;
  for (const id in state.players) {
    if (id === ignoreId) continue;
    if (overlaps({ x, y }, state.players[id], PLAYER_SIZE, PLAYER_SIZE)) return false;
  }
  return true;
}

// Ищет ближайшую свободную точку, начиная с желаемой позиции (обход кольцами
// по сетке с шагом PLAYER_SIZE). Возвращает желаемую позицию, если она свободна.
function findFreeSpot(preferred, ignoreId = null) {
  const px = Math.max(0, Math.min(MAP.w - PLAYER_SIZE, Math.round(preferred.x)));
  const py = Math.max(0, Math.min(MAP.h - PLAYER_SIZE, Math.round(preferred.y)));

  if (playerFree(px, py, ignoreId)) return { x: px, y: py };

  const maxR = Math.ceil(Math.max(MAP.w, MAP.h) / PLAYER_SIZE);
  for (let r = 1; r <= maxR; r++) {
    for (let i = -r; i <= r; i++) {
      const ring = [
        [px + i * PLAYER_SIZE, py - r * PLAYER_SIZE],
        [px + i * PLAYER_SIZE, py + r * PLAYER_SIZE],
        [px - r * PLAYER_SIZE, py + i * PLAYER_SIZE],
        [px + r * PLAYER_SIZE, py + i * PLAYER_SIZE]
      ];
      for (const [x, y] of ring) {
        if (x < 0 || y < 0 || x + PLAYER_SIZE > MAP.w || y + PLAYER_SIZE > MAP.h) continue;
        if (playerFree(x, y, ignoreId)) return { x, y };
      }
    }
  }

  // поле заполнено — пробуем случайные точки, иначе оставляем как есть
  for (let i = 0; i < 100; i++) {
    const p = randomPos(PLAYER_SIZE);
    if (playerFree(p.x, p.y, ignoreId)) return p;
  }
  return { x: px, y: py };
}

if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.players = loaded.players || {};
    state.coins = loaded.coins || [];
    for (const id in state.players) state.players[id].online = false;
    console.log(`Загружено: ${Object.keys(state.players).length} игроков, ${state.coins.length} монеток`);
  } catch (e) {
    console.error('Ошибка загрузки state:', e.message);
  }
}
while (state.coins.length < COIN_COUNT) spawnCoin();

// разрешаем пересечения, сохранённые в файле: отодвигаем на ближайшую свободную точку
for (const id in state.players) {
  const p = state.players[id];
  const spot = findFreeSpot(p, id);
  if (spot.x !== p.x || spot.y !== p.y) {
    console.log(`Пересечение при загрузке: ${id} (${p.x},${p.y}) → (${spot.x},${spot.y})`);
    p.x = spot.x; p.y = spot.y;
  }
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch (e) { console.error('Ошибка сохранения state:', e.message); }
}

// ---------- оффлайн-обработка ----------

function setPlayerOffline(sessionId) {
  if (!sessionId || !state.players[sessionId]) return;
  state.players[sessionId].online = false;
  state.players[sessionId].lastSeen = Date.now();
  broadcast({ type: 'offline', id: sessionId });
  saveState();
  console.log(`Оффлайн: ${sessionId}`);
}

// ---------- HTTP-сервер (раздаёт статику) ----------
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
  // health-check для Render
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  const urlPath = req.url.split('?')[0];
  const relPath = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath = path.join(CLIENT_DIR, relPath);

  // защита от path traversal
  if (!fullPath.startsWith(CLIENT_DIR)) {
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

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ server: httpServer });

// ---------- heartbeat-интервал (обнаружение потери соединения) ----------
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    // отправляем ping
    ws.ping();

    // если не было pong в течение HEARTBEAT_TIMEOUT — соединение мёртвое
    if (!ws.isAlive || now - (ws.lastPong || 0) > HEARTBEAT_TIMEOUT) {
      console.log(`Таймаут heartbeat, разрываем соединение (sessionId=${ws.sessionId || '?'})`);
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL);

// ---------- серверный пинг клиентам (чтобы не простаивало соединение) ----------
const serverPingInterval = setInterval(() => {
  broadcast({ type: 'ping' });
}, SERVER_PING_INTERVAL);

// ---------- проверка неактивности игроков ----------
const inactivityInterval = setInterval(() => {
  const now = Date.now();
  for (const id in state.players) {
    const p = state.players[id];
    if (p.online && now - p.lastSeen > INACTIVITY_TIMEOUT) {
      p.online = false;
      p.lastSeen = now;
      broadcast({ type: 'offline', id });
      saveState();
      console.log(`Неактивен: ${id}`);
    }
  }
}, 10000);

// очищаем интервалы при завершении процесса
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    clearInterval(heartbeatInterval);
    clearInterval(serverPingInterval);
    clearInterval(inactivityInterval);
  });
});

console.log('State file:', STATE_FILE);

function broadcast(msg, except = null) {
  const str = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === WebSocket.OPEN) c.send(str);
  }
}

wss.on('connection', (ws) => {
  // инициализация отслеживания соединения
  ws.isAlive = true;
  ws.lastPong = Date.now();
  ws.sessionId = null;

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastPong = Date.now();
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // обновляем метку активности при любом сообщении
    ws.isAlive = true;
    ws.lastPong = Date.now();

    if (data.type === 'hello') {
      if (data.sessionId && state.players[data.sessionId]) {
        ws.sessionId = data.sessionId;
        const p = state.players[ws.sessionId];
        // пока игрок был оффлайн, в его клетку мог зайти другой — отодвигаем рядом
        if (!playerFree(p.x, p.y, ws.sessionId)) {
          const spot = findFreeSpot(p, ws.sessionId);
          console.log(`Пересечение при возвращении: ${ws.sessionId} (${p.x},${p.y}) → (${spot.x},${spot.y})`);
          p.x = spot.x; p.y = spot.y;
        }
        p.online = true;
        p.lastSeen = Date.now();
        console.log(`Реконнект: ${ws.sessionId}`);
      } else {
        ws.sessionId = randomId();
        state.players[ws.sessionId] = {
          ...findFreeSpot(randomPos(PLAYER_SIZE), ws.sessionId),
          color: randomColor(),
          score: 0,
          online: true,
          lastSeen: Date.now()
        };
        console.log(`Новый игрок: ${ws.sessionId}`);
      }

      ws.send(JSON.stringify({
        type: 'init',
        id: ws.sessionId,
        players: state.players,
        coins: state.coins
      }));

      broadcast({ type: 'join', id: ws.sessionId, player: state.players[ws.sessionId] }, ws);
      saveState();
      return;
    }

    if (!ws.sessionId || !state.players[ws.sessionId]) return;
    state.players[ws.sessionId].lastSeen = Date.now();
    state.players[ws.sessionId].online = true;

    if (data.type === 'move') {
      const p = state.players[ws.sessionId];

      const nx = Math.max(0, Math.min(MAP.w - PLAYER_SIZE, p.x + data.dx));
      const ny = Math.max(0, Math.min(MAP.h - PLAYER_SIZE, p.y + data.dy));

      let blocked = false;
      for (const otherId in state.players) {
        if (otherId === ws.sessionId) continue;
        const other = state.players[otherId];
        // сквозные оффлайн-игроки — не блокируют движение
        if (other.online === false) continue;
        if (overlaps({ x: nx, y: ny }, other, PLAYER_SIZE, PLAYER_SIZE)) {
          blocked = true; break;
        }
      }
      if (!blocked) { p.x = nx; p.y = ny; }

      // атомарный захват монетки
      for (let i = state.coins.length - 1; i >= 0; i--) {
        const c = state.coins[i];
        if (overlaps({ x: p.x, y: p.y }, c, PLAYER_SIZE, COIN_SIZE)) {
          state.coins.splice(i, 1);
          p.score += 1;
          spawnCoin();
          console.log(` ${ws.sessionId} +балл, очки=${p.score}`);
        }
      }

      broadcast({ type: 'state', players: state.players, coins: state.coins });
      saveState();
    }
  });

  ws.on('close', () => {
    if (ws.sessionId && state.players[ws.sessionId]) {
      setPlayerOffline(ws.sessionId);
    }
  });

  ws.on('error', (e) => {
    console.error('WS error:', e.message);
    if (ws.sessionId && state.players[ws.sessionId]) {
      setPlayerOffline(ws.sessionId);
    }
  });
});

['SIGTERM', 'SIGINT'].forEach(sig => {
  process.on(sig, () => {
    console.log(`${sig} — сохраняю состояние...`);
    clearInterval(heartbeatInterval);
    saveState();
    wss.close(() => process.exit(0));
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});