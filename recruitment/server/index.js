const express = require('express');
const path = require('path');
const { pool, migrate } = require('./db');
const apiRouter = require('./api');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRouter);

// קישור הזמנה אישית — עמוד ציבורי נפרד (ללא זהות שגריר), מזוהה לפי הטוקן בכתובת
app.get('/invite/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'invite.html')));

// כלי הניהול הפנימי לשגרירים — לא בכתובת השורש, כדי שמי שמקבל קישור הזמנה אישית
// ומוחק חלק מהכתובת לא "ייפול" בטעות על לוח הניהול הפנימי
app.get('/team', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'team.html')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'שגיאת שרת' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await migrate();
  } catch (e) {
    console.error('❌ Database migration failed:', e.message);
    console.error('   ודאו ש-DATABASE_URL מוגדר נכון (Railway → ה-Postgres plugin → Variables).');
  }
  app.listen(PORT, () => console.log(`🚀 Recruitment server running on port ${PORT}`));
}

start();

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
