const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Раздаём статику (index.html, manifest.json и т.д.)
app.use(express.static(__dirname));

// === ХРАНИЛИЩЕ В ПАМЯТИ ===
// pairs: код -> { hostname, token, confirmed, createdAt }
const pairs = new Map();
// tokens: токен -> { code, hostname, stats, lastSeen }
const tokens = new Map();
// commands: токен -> { id, cmd, message, createdAt }
const commands = new Map();
let cmdIdCounter = 1;

// Очистка старых кодов каждые 10 минут (коды живут 5 минут)
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairs) {
    if (now - data.createdAt > 5 * 60 * 1000) {
      pairs.delete(code);
      console.log(`[CLEAN] Удалён старый код ${code}`);
    }
  }
}, 10 * 60 * 1000);

// === ГЛАВНАЯ СТРАНИЦА ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// === ПРОВЕРКА СЕРВЕРА ===
app.get('/api/health', (req, res) => {
  res.json({
    name: 'ChanceS Stats API',
    status: 'ok',
    uptime: process.uptime(),
    pairs: pairs.size,
    tokens: tokens.size,
    pendingCommands: commands.size
  });
});

// === ПРИВЯЗКА: АГЕНТ РЕГИСТРИРУЕТ КОД ===
app.post('/api/pair', (req, res) => {
  const { code, hostname } = req.body;
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  pairs.set(code, {
    hostname: hostname || 'unknown',
    token: null,
    confirmed: false,
    createdAt: Date.now()
  });
  console.log(`[PAIR] Код ${code} от ${hostname}`);
  res.json({ status: 'ok' });
});

// === СТАТУС КОДА: АГЕНТ ОПРАШИВАЕТ ===
app.get('/api/pair/status', (req, res) => {
  const { code } = req.query;
  const p = pairs.get(code);
  if (!p) return res.json({ status: 'not_found' });
  if (p.confirmed && p.token) {
    return res.json({ status: 'confirmed', token: p.token });
  }
  res.json({ status: 'pending' });
});

// === ПОДТВЕРЖДЕНИЕ: САЙТ ВВОДИТ КОД ===
app.post('/api/confirm', (req, res) => {
  const { code } = req.body;
  const p = pairs.get(code);
  if (!p || p.confirmed) {
    return res.json({ status: 'error', message: 'Неверный или использованный код' });
  }
  const token = 'tok_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  p.token = token;
  p.confirmed = true;
  tokens.set(token, {
    code: code,
    hostname: p.hostname,
    stats: null,
    lastSeen: Date.now()
  });
  console.log(`[CONFIRM] Код ${code} -> токен ${token.slice(0, 12)}...`);
  res.json({ status: 'ok', token: token });
});

// === СТАТИСТИКА: АГЕНТ ОТПРАВЛЯЕТ ===
app.post('/api/stats', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) {
    return res.json({ error: 'No data yet' });
  }
  const t = tokens.get(token);
  t.stats = req.body;
  t.lastSeen = Date.now();
  res.json({ status: 'ok' });
});

// === СТАТИСТИКА: САЙТ ЧИТАЕТ ===
app.get('/api/stats', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) {
    return res.json({ error: 'No data yet' });
  }
  const t = tokens.get(token);
  t.lastSeen = Date.now();
  res.json(t.stats || { error: 'No data yet' });
});

// === СПИСОК УСТРОЙСТВ (для сайта) ===
app.get('/api/devices', (req, res) => {
  const devices = [];
  for (const [token, data] of tokens) {
    devices.push({
      token: token,
      hostname: data.hostname,
      code: data.code,
      lastSeen: data.lastSeen,
      hasStats: !!data.stats
    });
  }
  res.json(devices);
});

// === КОМАНДА: САЙТ ОТПРАВЛЯЕТ ===
app.post('/api/command', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { cmd, message } = req.body;
  if (!cmd) return res.status(400).json({ error: 'No command' });
  commands.set(token, {
    id: cmdIdCounter++,
    cmd: cmd,
    message: message || null,
    createdAt: Date.now()
  });
  console.log(`[CMD] Токен ${token.slice(0, 12)}... -> ${cmd}`);
  res.json({ status: 'ok', id: cmdIdCounter - 1 });
});

// === КОМАНДЫ: АГЕНТ ЗАБИРАЕТ ===
app.get('/api/commands', (req, res) => {
  const { token } = req.query;
  if (!token || !commands.has(token)) {
    return res.json({});
  }
  const cmd = commands.get(token);
  commands.delete(token); // одноразовая команда
  res.json(cmd);
});

// === ПОДТВЕРЖДЕНИЕ КОМАНДЫ ===
app.post('/api/commands/ack', (req, res) => {
  res.json({ status: 'ok' });
});

// === ОТВЯЗКА УСТРОЙСТВА ===
app.post('/api/unpair', (req, res) => {
  const token = req.headers['x-pair-token'] || req.body.token;
  if (token && tokens.has(token)) {
    const data = tokens.get(token);
    pairs.delete(data.code);
    tokens.delete(token);
    commands.delete(token);
    console.log(`[UNPAIR] Токен ${token.slice(0, 12)}... отвязан`);
    return res.json({ status: 'ok' });
  }
  res.json({ status: 'error', message: 'Token not found' });
});

// === ЗАПУСК ===
app.listen(PORT, () => {
  console.log(`✅ ChanceS Stats API running on port ${PORT}`);
  console.log(`🌐 Открыть: http://localhost:${PORT}`);
});
