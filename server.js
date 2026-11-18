// ============================================================
// ChanceS Stats API Server — полный сервер с привязкой устройств
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// === ХРАНИЛИЩЕ В ПАМЯТИ ===
// pairs: код привязки -> данные устройства
const pairs = new Map();
// tokens: токен устройства -> данные сессии
const tokens = new Map();
// commands: токен -> очередь команд (одна на устройство)
const commands = new Map();
// Счётчик ID команд
let cmdIdCounter = 1;

// === ОЧИСТКА СТАРЫХ КОДОВ (каждые 10 минут удаляем коды старше 5 минут) ===
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, data] of pairs) {
    if (now - data.createdAt > 5 * 60 * 1000) {
      pairs.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[CLEAN] Удалено ${cleaned} устаревших кодов привязки`);
  }
}, 10 * 60 * 1000);

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

function generateToken() {
  return 'tok_' + crypto.randomBytes(16).toString('hex');
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isAuthenticated(req, res) {
  const token = req.headers['x-pair-token'] || req.query.token;
  if (!token || !tokens.has(token)) {
    res.status(401).json({ error: 'Unauthorized', message: 'Неверный или отсутствующий токен' });
    return null;
  }
  return token;
}

// === ЛОГГЕР ===
function log(method, url, status, extra = '') {
  const time = new Date().toLocaleTimeString('ru-RU');
  console.log(`[${time}] ${method} ${url} -> ${status} ${extra}`);
}

// ============================================================
// ЭНДПОИНТЫ
// ============================================================

// === 0. Главная страница ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// === 1. Проверка здоровья сервера ===
app.get('/api/health', (req, res) => {
  const info = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    pairs: pairs.size,
    tokens: tokens.size,
    commands: commands.size
  };
  log('GET', '/api/health', 200);
  res.json(info);
});

// === 2. Агент регистрирует код привязки ===
app.post('/api/pair', (req, res) => {
  const { code, hostname } = req.body;

  if (!code || String(code).length !== 6) {
    log('POST', '/api/pair', 400, '(неверный код)');
    return res.status(400).json({ error: 'Invalid code', message: 'Код должен быть 6 цифр' });
  }

  const codeStr = String(code);

  // Если код уже есть — обновляем, не создаём дубль
  if (pairs.has(codeStr)) {
    const existing = pairs.get(codeStr);
    existing.hostname = hostname || existing.hostname;
    existing.createdAt = Date.now();
    log('POST', '/api/pair', 200, `(обновлён ${codeStr})`);
    return res.json({ status: 'ok', message: 'Код обновлён' });
  }

  pairs.set(codeStr, {
    code: codeStr,
    hostname: hostname || 'unknown',
    token: null,
    confirmed: false,
    createdAt: Date.now()
  });

  log('POST', '/api/pair', 200, `(код ${codeStr} от ${hostname || 'unknown'})`);
  res.json({ status: 'ok', code: codeStr });
});

// === 3. Агент проверяет статус кода (polling) ===
app.get('/api/pair/status', (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  const p = pairs.get(String(code));

  if (!p) {
    log('GET', '/api/pair/status', 200, `(код ${code} не найден)`);
    return res.json({ status: 'not_found' });
  }

  if (p.confirmed && p.token) {
    log('GET', '/api/pair/status', 200, `(код ${code} подтверждён)`);
    return res.json({ status: 'confirmed', token: p.token });
  }

  log('GET', '/api/pair/status', 200, `(код ${code} ожидает)`);
  res.json({ status: 'pending' });
});

// === 4. Сайт подтверждает код → выдаёт токен ===
app.post('/api/confirm', (req, res) => {
  const { code } = req.body;

  if (!code) {
    log('POST', '/api/confirm', 400, '(нет кода)');
    return res.status(400).json({ status: 'error', message: 'Код не указан' });
  }

  const p = pairs.get(String(code));

  if (!p) {
    log('POST', '/api/confirm', 400, `(код ${code} не найден)`);
    return res.json({ status: 'error', message: 'Неверный код' });
  }

  if (p.confirmed) {
    log('POST', '/api/confirm', 400, `(код ${code} уже использован)`);
    return res.json({ status: 'error', message: 'Код уже использован' });
  }

  // Генерируем криптографически стойкий токен
  const token = generateToken();
  p.token = token;
  p.confirmed = true;

  tokens.set(token, {
    code: String(code),
    hostname: p.hostname,
    stats: null,
    lastSeen: Date.now(),
    createdAt: Date.now()
  });

  log('POST', '/api/confirm', 200, `(код ${code} -> токен ${token.slice(0, 12)}...)`);
  res.json({ status: 'ok', token: token, hostname: p.hostname });
});

// === 5. Агент отправляет статистику ===
app.post('/api/stats', (req, res) => {
  const token = req.headers['x-pair-token'];

  if (!token || !tokens.has(token)) {
    log('POST', '/api/stats', 401, '(нет токена)');
    return res.status(401).json({ error: 'Unauthorized', message: 'Устройство не привязано' });
  }

  const t = tokens.get(token);
  t.stats = req.body;
  t.lastSeen = Date.now();

  log('POST', '/api/stats', 200, `(устройство ${t.hostname})`);
  res.json({ status: 'ok', received: true });
});

// === 6. Сайт читает статистику устройства ===
app.get('/api/stats', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];

  if (!token || !tokens.has(token)) {
    return res.json({ error: 'No data yet', message: 'Устройство не подключено' });
  }

  const t = tokens.get(token);
  t.lastSeen = Date.now();

  log('GET', '/api/stats', 200, `(устройство ${t.hostname})`);
  res.json(t.stats || { error: 'No data yet' });
});

// === 7. Список всех подключённых устройств (защищён) ===
app.get('/api/devices', (req, res) => {
  const token = req.query.token || req.headers['x-pair-token'];

  if (!token || !tokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const devices = [];
  for (const [tok, data] of tokens) {
    devices.push({
      token: tok,
      hostname: data.hostname,
      code: data.code,
      lastSeen: data.lastSeen,
      hasStats: !!data.stats,
      online: (Date.now() - data.lastSeen) < 30000 // онлайн если данные были < 30 сек назад
    });
  }

  log('GET', '/api/devices', 200, `(${devices.length} устройств)`);
  res.json(devices);
});

// === 8. Сайт отправляет команду устройству ===
app.post('/api/command', (req, res) => {
  const token = req.headers['x-pair-token'];

  if (!token || !tokens.has(token)) {
    log('POST', '/api/command', 401, '(нет токена)');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { cmd, message } = req.body;

  if (!cmd) {
    log('POST', '/api/command', 400, '(нет команды)');
    return res.status(400).json({ error: 'No command', message: 'Команда не указана' });
  }

  // Разрешённые команды
  const allowed = ['shutdown', 'restart', 'sleep', 'lock', 'ping', 'custom'];
  const isTimer = cmd.startsWith('timer:');

  if (!allowed.includes(cmd) && !isTimer) {
    log('POST', '/api/command', 400, `(неизвестная команда ${cmd})`);
    return res.status(400).json({ error: 'Unknown command' });
  }

  commands.set(token, {
    id: cmdIdCounter++,
    cmd: cmd,
    message: message || null,
    createdAt: Date.now()
  });

  const t = tokens.get(token);
  log('POST', '/api/command', 200, `(устройство ${t.hostname} -> ${cmd})`);
  res.json({ status: 'ok', id: cmdIdCounter - 1 });
});

// === 9. Агент забирает команду (одноразовая) ===
app.get('/api/commands', (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.json({});
  }

  if (!commands.has(token)) {
    return res.json({});
  }

  const cmd = commands.get(token);
  commands.delete(token); // удаляем после получения — одноразовая

  log('GET', '/api/commands', 200, `(команда ${cmd.cmd})`);
  res.json(cmd);
});

// === 10. Агент подтверждает выполнение команды ===
app.post('/api/commands/ack', (req, res) => {
  const { token, id } = req.body;
  log('POST', '/api/commands/ack', 200, `(id ${id || 'unknown'})`);
  res.json({ status: 'ok' });
});

// === 11. Отвязка устройства ===
app.post('/api/unpair', (req, res) => {
  const token = req.headers['x-pair-token'] || (req.body && req.body.token);

  if (!token || !tokens.has(token)) {
    log('POST', '/api/unpair', 400, '(токен не найден)');
    return res.json({ status: 'error', message: 'Токен не найден' });
  }

  const data = tokens.get(token);

  // Удаляем код привязки
  if (data.code && pairs.has(data.code)) {
    pairs.delete(data.code);
  }

  // Удаляем токен и его команды
  tokens.delete(token);
  commands.delete(token);

  log('POST', '/api/unpair', 200, `(устройство ${data.hostname} отвязано)`);
  res.json({ status: 'ok', message: 'Устройство отвязано' });
});

// === 12. Информация о сервере (для отладки) ===
app.get('/api/info', (req, res) => {
  const info = {
    name: 'ChanceS Stats API',
    version: '1.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pairs: pairs.size,
    tokens: tokens.size,
    commands: commands.size,
    endpoints: [
      'GET  /api/health',
      'POST /api/pair',
      'GET  /api/pair/status?code=',
      'POST /api/confirm',
      'POST /api/stats',
      'GET  /api/stats?token=',
      'GET  /api/devices?token=',
      'POST /api/command',
      'GET  /api/commands?token=',
      'POST /api/commands/ack',
      'POST /api/unpair',
      'GET  /api/info'
    ]
  };
  log('GET', '/api/info', 200);
  res.json(info);
});

// === ОБРАБОТКА 404 ===
app.use((req, res) => {
  log(req.method, req.url, 404);
  res.status(404).json({ error: 'Not found', path: req.url });
});

// === ОБРАБОТКА ОШИБОК ===
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// === ЗАПУСК ===
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   ChanceS Stats API Server v1.0.0        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Порт: ${String(PORT).padEnd(33)}║`);
  console.log(`║   Адрес: http://localhost:${PORT}          ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('[READY] Сервер запущен и готов принимать подключения');
});
