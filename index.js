const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const pairs = new Map();
const tokens = new Map();
const commands = new Map();
let cmdId = 1;

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairs) {
    if (now - data.createdAt > 5 * 60 * 1000) pairs.delete(code);
  }
}, 10 * 60 * 1000);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', pairs: pairs.size, tokens: tokens.size }));

app.post('/api/pair', (req, res) => {
  const { code, hostname } = req.body;
  if (!code || code.length !== 6) return res.status(400).json({ error: 'Invalid code' });
  pairs.set(code, { hostname: hostname || 'unknown', token: null, confirmed: false, createdAt: Date.now() });
  console.log('[PAIR]', code, hostname);
  res.json({ status: 'ok' });
});

app.get('/api/pair/status', (req, res) => {
  const p = pairs.get(req.query.code);
  if (!p) return res.json({ status: 'not_found' });
  if (p.confirmed && p.token) return res.json({ status: 'confirmed', token: p.token });
  res.json({ status: 'pending' });
});

app.post('/api/confirm', (req, res) => {
  const p = pairs.get(req.body.code);
  if (!p || p.confirmed) return res.json({ status: 'error', message: 'Неверный код' });
  const token = 'tok_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  p.token = token;
  p.confirmed = true;
  tokens.set(token, { code: req.body.code, hostname: p.hostname, stats: null, lastSeen: Date.now() });
  console.log('[CONFIRM]', req.body.code, '->', token.slice(0, 12));
  res.json({ status: 'ok', token });
});

app.post('/api/stats', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.json({ error: 'No data yet' });
  const t = tokens.get(token);
  t.stats = req.body;
  t.lastSeen = Date.now();
  res.json({ status: 'ok' });
});

app.get('/api/stats', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.json({ error: 'No data yet' });
  res.json(tokens.get(token).stats || { error: 'No data yet' });
});

app.post('/api/command', (req, res) => {
  const token = req.headers['x-pair-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  const { cmd, message } = req.body;
  if (!cmd) return res.status(400).json({ error: 'No command' });
  commands.set(token, { id: cmdId++, cmd, message: message || null, createdAt: Date.now() });
  console.log('[CMD]', cmd);
  res.json({ status: 'ok' });
});

app.get('/api/commands', (req, res) => {
  const { token } = req.query;
  if (!token || !commands.has(token)) return res.json({});
  const cmd = commands.get(token);
  commands.delete(token);
  res.json(cmd);
});

app.post('/api/commands/ack', (req, res) => res.json({ status: 'ok' }));

app.post('/api/unpair', (req, res) => {
  const token = req.headers['x-pair-token'] || req.body.token;
  if (token && tokens.has(token)) {
    pairs.delete(tokens.get(token).code);
    tokens.delete(token);
    commands.delete(token);
    return res.json({ status: 'ok' });
  }
  res.json({ status: 'error' });
});

app.listen(PORT, () => console.log('✅ ChanceS API on port', PORT));
