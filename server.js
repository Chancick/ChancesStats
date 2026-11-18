const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// === ХРАНИЛИЩЕ В ПАМЯТИ ===
const pairs = new Map();      // код -> { hostname, token, confirmed, createdAt }
const tokens = new Map();     // токен -> { code, hostname, stats, lastSeen }
const commands = new Map();   // токен -> { id, cmd, message, createdAt }
let cmdId = 1;

// Очистка старых кодов каждые 10 минут (коды живут 5 минут)
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairs) {
    if (now - data.createdAt > 5 * 60 * 1000) pairs.delete(code);
  }
}, 10 * 60 * 1000);

// === ГЛАВНАЯ СТРАНИЦА ===
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// === ПРОВЕРКА СЕРВЕРА ===
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', pairs: pairs.size, tokens: tokens.size });
});

// === 1. АГЕНТ РЕГИСТРИРУЕТ КОД ===
app.post('/api/pair', (req, res) => {
  const { code, hostname } = req.body;
  if (!code || String(code).length !== 6) return res.status(400).json({ error: 'Invalid code' });
  pairs.set(String(code), { hostname: hostname || 'unknown', token: null, confirmed: false, createdAt: Date.now() });
  console.log('[PAIR] Код', code, 'от', hostname);
  res.json({ status: 'ok' });
});

// === 2. АГЕНТ ПРОВЕРЯЕТ СТАТУС КОДА ===
app.get('/api/pair/status', (req, res) => {
  const p = pairs.get(req.query.code);
  if (!p) return res.json({ status: 'not_found' });
  if (p.confirmed && p.token) return res.json({ status: 'confirmed', token: p.token });
  res.json({ status: 'pending' });
});

// === 3. САЙТ ПОДТВЕРЖДАЕТ КОД (ЭТОГО НЕ ХВАТАЛО!) ===
app.post('/api/confirm', (req, res) => {
  const p = pairs.get(req.body.code);
  if (!p || p.confirmed) {
    return res.json({ status: 'error', message: 'Неверный или использованный код' });
  }
  const token = 'tok_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  p.token = token;
  p.confirmed = true;
  tokens.set(token, { code: req.body.code, hostname: p.hostname, stats: null, lastSeen: Date.now() });
  console.log('[CONFIRM] Код', req.body.code, '-> токен', token.slice(0, 12));
  res.json({ status: 'ok', token });
});

// === 4. АГЕНТ ШЛЁТ СТАТИСТИКУ ===
app.post('/api/stats', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.json({ error: 'No data yet' });
  const t = tokens.get(token);
  t.stats = req.body;
  t.lastSeen = Date.now();
  res.json({ status: 'ok' });
});

// === 5. САЙТ ЧИТАЕТ СТАТИСТИКУ ===
app.get('/api/stats', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.json({ error: 'No data yet' });
  const t = tokens.get(token);
  t.lastSeen = Date.now();
  res.json(t.stats || { error: 'No data yet' });
});

// === 6. СПИСОК УСТРОЙСТВ ===
app.get('/api/devices', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  const devices = [];
  for (const [t, data] of tokens) {
    devices.push({ token: t, hostname: data.hostname, code: data.code, lastSeen: data.lastSeen, hasStats: !!data.stats });
  }
  res.json(devices);
});

// === 7. САЙТ ОТПРАВЛЯЕТ КОМАНДУ ===
app.post('/api/command', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  const { cmd, message } = req.body;
  if (!cmd) return res.status(400).json({ error: 'No command' });
  commands.set(token, { id: cmdId++, cmd, message: message || null, createdAt: Date.now() });
  console.log('[CMD] Токен', token.slice(0, 12), '->', cmd);
  res.json({ status: 'ok' });
});

// === 8. АГЕНТ ЗАБИРАЕТ КОМАНДУ ===
app.get('/api/commands', (req, res) => {
  const { token } = req.query;
  if (!token || !commands.has(token)) return res.json({});
  const cmd = commands.get(token);
  commands.delete(token); // одноразовая команда
  res.json(cmd);
});

// === 9. АГЕНТ ПОДТВЕРЖДАЕТ КОМАНДУ ===
app.post('/api/commands/ack', (req, res) => res.json({ status: 'ok' }));

// === 10. ОТВЯЗКА УСТРОЙСТВА ===
app.post('/api/unpair', (req, res) => {
  const token = req.headers['x-pair-token'] || req.body.token;
  if (token && tokens.has(token)) {
    const data = tokens.get(token);
    pairs.delete(data.code);
    tokens.delete(token);
    commands.delete(token);
    console.log('[UNPAIR] Токен', token.slice(0, 12), 'отвязан');
    return res.json({ status: 'ok' });
  }
  res.json({ status: 'error', message: 'Token not found' });
});

app.listen(PORT, () => console.log('✅ ChanceS API running on port', PORT));
