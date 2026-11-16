const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Раздаём статику из корня проекта
app.use(express.static(__dirname));

let latestStats = {};

app.post('/api/stats', (req, res) => {
    latestStats = { ...req.body, received_at: Date.now() };
    console.log(`[${new Date().toLocaleTimeString()}] Данные получены`);
    res.json({ status: 'ok' });
});

app.get('/api/stats', (req, res) => {
    if (!latestStats || Object.keys(latestStats).length === 0) {
        return res.status(404).json({ error: 'No data yet' });
    }
    res.json(latestStats);
});

// Отдаём index.html на главной
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
