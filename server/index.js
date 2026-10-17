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
const COOKIE_SIZE = 12;
const COOKIE_COUNT = 8;

let state = {
  players: {},
  cookies: []
};

// ---------- утилиты ----------
const rnd = (max) => Math.floor(Math.random() * max);
const randomColor = () =>
  '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
const randomId = () => Math.random().toString(36).substring(2, 11);
const randomPos = (size) => ({ x: rnd(MAP.w - size), y: rnd(MAP.h - size) });

function spawnCookie() {
  state.cookies.push({ id: randomId(), ...randomPos(COOKIE_SIZE) });
}

function overlaps(a, b, sa, sb) {
  return a.x < b.x + sb && a.x + sa > b.x &&
         a.y < b.y + sb && a.y + sa > b.y;
}

if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.players = loaded.players || {};
    state.cookies = loaded.cookies || [];
    for (const id in state.players) state.players[id].online = false;
    console.log(`Загружено: ${Object.keys(state.players).length} игроков, ${state.cookies.length} печенек`);
  } catch (e) {
    console.error('Ошибка загрузки state:', e.message);
  }
}
while (state.cookies.length < COOKIE_COUNT) spawnCookie();

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
        state.players[ws.sessionId].online = true;
        state.players[ws.sessionId].lastSeen = Date.now();
        console.log(`Реконнект: ${ws.sessionId}`);
      } else {
        ws.sessionId = randomId();
        state.players[ws.sessionId] = {
          ...randomPos(PLAYER_SIZE),
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
        cookies: state.cookies
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
        if (overlaps({ x: nx, y: ny }, state.players[otherId], PLAYER_SIZE, PLAYER_SIZE)) {
          blocked = true; break;
        }
      }
      if (!blocked) { p.x = nx; p.y = ny; }

      // атомарный захват монетки
      for (let i = state.cookies.length - 1; i >= 0; i--) {
        const c = state.cookies[i];
        if (overlaps({ x: p.x, y: p.y }, c, PLAYER_SIZE, COOKIE_SIZE)) {
          state.cookies.splice(i, 1);
          p.score += 1;
          spawnCookie();
          console.log(` ${ws.sessionId} +балл, очки=${p.score}`);
        }
      }

      broadcast({ type: 'state', players: state.players, cookies: state.cookies });
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