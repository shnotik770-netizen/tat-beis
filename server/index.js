const express = require('express');
const path = require('path');
const { pool, migrate } = require('./db');
const api = require('./api');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// כל פונקציה שנחשפת ל-google.script.run בלקוח חייבת להופיע כאן
const ALLOWED_FUNCTIONS = new Set(Object.keys(api));

// נקודת קצה גנרית אחת: POST /api/<functionName> עם body = מערך הארגומנטים
// זה ממפה ישירות לתבנית google.script.run.withSuccessHandler(...).functionName(arg1, arg2)
app.post('/api/:fn', async (req, res) => {
  const fn = req.params.fn;
  if (!ALLOWED_FUNCTIONS.has(fn)) {
    return res.status(404).json({ __error: `פונקציה לא מוכרת: ${fn}` });
  }
  try {
    const args = Array.isArray(req.body) ? req.body : [];
    const result = await api[fn](...args);
    res.json(result);
  } catch (e) {
    console.error(`Error in ${fn}:`, e);
    res.status(500).json({ __error: e.message || 'שגיאת שרת' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await migrate();
  } catch (e) {
    console.error('❌ Database migration failed:', e.message);
    console.error('   Make sure DATABASE_URL is set correctly (Railway → your Postgres plugin → Variables).');
  }
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

start();

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
