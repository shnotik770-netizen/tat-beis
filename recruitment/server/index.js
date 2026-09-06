const fs = require('fs');
const express = require('express');
const path = require('path');
const { pool, migrate } = require('./db');
const apiRouter = require('./api');
const sheetsSync = require('./sheets');
const { renderInviteCardPng } = require('./inviteCard');
const { PUBLIC_BASE_URL } = require('./config');

const app = express();
app.use(express.json({ limit: '8mb' })); // כולל מקום לתמונות לוגו/הזמנה בבסיס 64 שמנהל קמפיין מעלה

// תבנית עמוד ההזמנה האישית נטענת פעם אחת לזיכרון — היא לא משתנה בזמן ריצה, רק מוחלפים
// בה placeholder-ים לכל בקשה (ראו /invite/:token למטה)
const inviteHtmlTemplate = fs.readFileSync(path.join(__dirname, '..', 'public', 'invite.html'), 'utf8');

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

// כתובת השורש מפנה לאתר "הכוח לצמוח" (עמוד נחיתה נפרד על צמיחת בית החינוך) —
// דף האירוע/ה-index הישן נשאר נגיש ישירות בכתובת /event למי שצריך אותו
app.get('/', (req, res) => res.redirect(302, 'https://tzmicha-site-production.up.railway.app/'));
app.get('/event', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRouter);

// קישור מקוצר (/i/<code>) — חלופה קצרה לנוחות שיתוף, שרק מפנה לקישור המלא הרגיל.
// לא מחליף אותו: קישורים ארוכים שכבר נשלחו/נשמרו ממשיכים לעבוד בדיוק כמו היום בלי שינוי.
app.get('/i/:code', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT invite_token FROM contacts WHERE short_code = $1', [req.params.code]);
    if (!rows[0] || !rows[0].invite_token) return res.status(404).send('קישור לא נמצא.');
    res.redirect(302, `/invite/${rows[0].invite_token}`);
  } catch (e) {
    res.status(500).send('שגיאת שרת.');
  }
});

// שם הפנייה מוזן ידנית ע"י שגריר, ולא היה עד כה מוטמע ישירות ב-HTML — יש לברוח אותו לפני
// הזרקה לתבנית כדי למנוע HTML/attribute injection דרך שם שהוזן בכוונה רעה
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// קישור הזמנה אישית — עמוד ציבורי נפרד (ללא זהות שגריר), מזוהה לפי הטוקן בכתובת.
// מוגש דרך תבנית עם placeholder-ים (לא sendFile סטטי) כדי שתגי og:title/og:image יהיו
// מותאמים אישית לאורח הספציפי — קריטי כי רשתות חברתיות/אפליקציות הודעות סורקות את ה-HTML
// הגולמי בלי להריץ JS, כך שלא ניתן להזריק את זה בצד הלקוח.
app.get('/invite/:token', async (req, res) => {
  const token = req.params.token;
  let title = 'הזמנה אישית — ערב שותפות | חב"ד עפולה';
  try {
    const { rows } = await pool.query(
      'SELECT name, invite_greeting_name FROM contacts WHERE invite_token = $1',
      [token]
    );
    if (rows[0]) {
      const guest = rows[0].invite_greeting_name || rows[0].name;
      title = `הזמנה אישית לכבוד ${guest} — ערב שותפות`;
    }
  } catch (e) { /* נשארים עם הכותרת הגנרית */ }
  const imageUrl = `${PUBLIC_BASE_URL}/invite/${encodeURIComponent(token)}/og-image.png`;
  const pageUrl = `${PUBLIC_BASE_URL}/invite/${encodeURIComponent(token)}`;
  const html = inviteHtmlTemplate
    .split('__OG_TITLE__').join(escHtml(title))
    .split('__OG_IMAGE_URL__').join(escHtml(imageUrl))
    .split('__OG_URL__').join(escHtml(pageUrl));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// תמונת תצוגה מקדימה (og:image) מותאמת אישית — נוצרת בזמן אמת עם שם האורח שממש מוזמן,
// לא תמונת "Save the Date" אחידה לכולם. נופלת בחזרה לתמונה הסטטית אם הטוקן לא נמצא/נכשל.
app.get('/invite/:token/og-image.png', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.name, c.invite_greeting_name, c.invite_companion_name,
              s.invite_brand_text, s.event_tagline, s.event_date_text, s.event_location
       FROM contacts c CROSS JOIN campaign_settings s
       WHERE c.invite_token = $1 AND s.id = 1`,
      [req.params.token]
    );
    if (!rows[0]) return res.redirect(302, '/assets/save-the-date.jpg');
    const c = rows[0];
    const png = renderInviteCardPng({
      brandText: c.invite_brand_text || 'ערב שותפות',
      guestName: c.invite_greeting_name || c.name,
      companionName: c.invite_companion_name || '',
      tagline: c.event_tagline || '',
      dateText: c.event_date_text || '',
      location: c.event_location || ''
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(png);
  } catch (e) {
    console.error('שגיאה ביצירת תמונת הזמנה אישית:', e.message);
    res.redirect(302, '/assets/save-the-date.jpg');
  }
});

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
  // רענון מלא אוטומטי של דוח גוגל שיטס — פועל רק אם GOOGLE_SERVICE_ACCOUNT_* מוגדרים (ראו README)
  sheetsSync.startAutoSync(Number(process.env.GOOGLE_SHEET_SYNC_MINUTES) || 5);
}

start();

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
