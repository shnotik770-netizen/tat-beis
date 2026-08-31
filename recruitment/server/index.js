const express = require('express');
const path = require('path');
const { pool, migrate } = require('./db');
const apiRouter = require('./api');

const app = express();
app.use(express.json({ limit: '8mb' })); // כולל מקום לתמונות לוגו/הזמנה בבסיס 64 שמנהל קמפיין מעלה

// לוגו ותמונת ההזמנה — אם מנהל קמפיין העלה גרסה מותאמת (שמורה ב-DB, לא בדיסק המקומי
// שנמחק בכל פריסה מחדש), מגישים אותה; אחרת נופלים לקובץ ברירת המחדל ב-public/assets
app.get('/assets/logo.png', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT logo_image, logo_image_type FROM campaign_settings WHERE id = 1');
    if (rows[0] && rows[0].logo_image) {
      res.set('Content-Type', rows[0].logo_image_type || 'image/png');
      return res.send(rows[0].logo_image);
    }
  } catch (e) { /* נופלים לקובץ הסטטי */ }
  next();
});
app.get('/assets/save-the-date.jpg', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT hero_image, hero_image_type FROM campaign_settings WHERE id = 1');
    if (rows[0] && rows[0].hero_image) {
      res.set('Content-Type', rows[0].hero_image_type || 'image/jpeg');
      return res.send(rows[0].hero_image);
    }
  } catch (e) { /* נופלים לקובץ הסטטי */ }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRouter);

// קישור הזמנה אישית — עמוד ציבורי נפרד (ללא זהות שגריר), מזוהה לפי הטוקן בכתובת
app.get('/invite/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'invite.html')));

// כלי הניהול הפנימי לשגרירים — לא בכתובת השורש וללא קישור גלוי מעמוד הנחיתה,
// כדי שמי שמקבל קישור הזמנה אישית ומוחק חלק מהכתובת לא "ייפול" בטעות על לוח הניהול
app.get('/shagririm', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'team.html')));

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
