const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Хранилище в памяти
const pairs = new Map();      // code -> { hostname, token, confirmed, createdAt }
const tokens = new Map();     // token -> { code, hostname, stats, lastSeen }
const commands = new Map();   // token -> { id, cmd, message }
let cmdId = 1;

// Очистка старых кодов (живут 5 минут)
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairs) {
    if (now - data.createdAt > 5 * 60 * 1000) pairs.delete(code);
  }
}, 10 * 60 * 1000);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (req, res) => res.json({ status: 'ok', pairs: pairs.size, tokens: tokens.size }));

// 1. Агент регистрирует код
app.post('/api/pair', (req, res) => {
  const { code, hostname } = req.body;
  if (!code || String(code).length !== 6) return res.status(400).json({ error: 'Invalid code' });
  pairs.set(String(code), { hostname: hostname || 'unknown', token: null, confirmed: false, createdAt: Date.now() });
  console.log('[PAIR] Код', code, 'от', hostname);
  res.json({ status: 'ok' });
});

// 2. Агент проверяет статус
app.get('/api/pair/status', (req, res) => {
  const p = pairs.get(req.query.code);
  if (!p) return res.json({ status: 'not_found' });
  if (p.confirmed && p.token) return res.json({ status: 'confirmed', token: p.token });
  res.json({ status: 'pending' });
});

// 3. Сайт подтверждает код (ГЕНЕРАЦИЯ КРИПТО-ТОКЕНА)
app.post('/api/confirm', (req, res) => {
  const p = pairs.get(req.body.code);
  if (!p || p.confirmed) return res.json({ status: 'error', message: 'Неверный код' });
  
  const token = 'tok_' + crypto.randomBytes(16).toString('hex'); // Безопасный токен
  p.token = token;
  p.confirmed = true;
  tokens.set(token, { code: req.body.code, hostname: p.hostname, stats: null, lastSeen: Date.now() });
  console.log('[CONFIRM] Код', req.body.code, '-> токен', token.slice(0, 12));
  res.json({ status: 'ok', token });
});

// 4. Агент шлёт статистику
app.post('/api/stats', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.json({ error: 'No data yet' });
  const t = tokens.get(token);
  t.stats = req.body;
  t.lastSeen = Date.now();
  res.json({ status: 'ok' });
});

// 5. Сайт читает статистику
app.get('/api/stats', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.json({ error: 'No data yet' });
  res.json(tokens.get(token).stats || { error: 'No data yet' });
});

// 6. Список устройств (ЗАЩИЩЁН ТОКЕНОМ)
app.get('/api/devices', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  const devices = [];
  for (const [t, data] of tokens) {
    devices.push({ token: t, hostname: data.hostname, lastSeen: data.lastSeen, hasStats: !!data.stats });
  }
  res.json(devices);
});

// 7. Сайт отправляет команду
app.post('/api/command', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  const { cmd, message } = req.body;
  if (!cmd) return res.status(400).json({ error: 'No command' });
  commands.set(token, { id: cmdId++, cmd, message: message || null, createdAt: Date.now() });
  console.log('[CMD] Токен', token.slice(0, 12), '->', cmd);
  res.json({ status: 'ok' });
});

// 8. Агент забирает команду (одноразовая)
app.get('/api/commands', (req, res) => {
  const { token } = req.query;
  if (!token || !commands.has(token)) return res.json({});
  const cmd = commands.get(token);
  commands.delete(token); 
  res.json(cmd);
});

// 9. Агент подтверждает выполнение
app.post('/api/commands/ack', (req, res) => {
  res.json({ status: 'ok' });
});

// 10. Отвязка устройства
app.post('/api/unpair', (req, res) => {
  const token = req.headers['x-pair-token'] || req.body.token;
  if (token && tokens.has(token)) {
    const data = tokens.get(token);
    if (data.code) pairs.delete(data.code);
    tokens.delete(token);
    commands.delete(token);
    console.log('[UNPAIR] Токен', token.slice(0, 12), 'отвязан');
    return res.json({ status: 'ok' });
  }
  res.json({ status: 'error' });
});

app.listen(PORT, () => console.log('✅ ChanceS API running on port', PORT));
