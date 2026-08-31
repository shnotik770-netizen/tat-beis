const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { hashPin, generateInviteToken } = require('./auth');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set. Set it to your PostgreSQL connection string (Railway sets this automatically once you add a Postgres plugin).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await seedAdmin();
  await backfillInviteTokens();
  console.log('✅ Database schema is up to date.');
}

// לכל איש קשר צריך להיות טוקן הזמנה אישי ייחודי — ממלאים חסרים (התקנה קיימת, או שורות שנוספו לפני שהפיצ'ר קיים)
async function backfillInviteTokens() {
  const { rows } = await pool.query('SELECT id FROM contacts WHERE invite_token IS NULL');
  for (const r of rows) {
    await pool.query('UPDATE contacts SET invite_token = $1 WHERE id = $2', [generateInviteToken(), r.id]);
  }
  if (rows.length) console.log(`🎟️ הוגדר טוקן הזמנה אישי ל-${rows.length} אנשי קשר קיימים.`);
}

async function seedAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM ambassadors');
  const defaultPin = process.env.ADMIN_PIN || '1414';
  if (rows[0].c === 0) {
    const name = process.env.ADMIN_NAME || 'מנהל';
    await pool.query(
      'INSERT INTO ambassadors (name, phone, is_admin, pin_hash) VALUES ($1, $2, TRUE, $3)',
      [name, null, hashPin(defaultPin)]
    );
    console.log(`👤 נוצר שגריר-מנהל ראשוני: "${name}" עם קוד גישה "${defaultPin}". רק למנהלים יש קוד; שגרירים רגילים נכנסים בלי קוד ממסך "מי אתה?".`);
    return;
  }
  // מערכות קיימות: לוודא שלכל מנהל שאין לו עדיין קוד גישה יוגדר קוד ברירת מחדל
  const { rows: adminsWithoutPin } = await pool.query('SELECT id, name FROM ambassadors WHERE is_admin = TRUE AND pin_hash IS NULL');
  for (const a of adminsWithoutPin) {
    await pool.query('UPDATE ambassadors SET pin_hash = $1 WHERE id = $2', [hashPin(defaultPin), a.id]);
    console.log(`🔑 הוגדר קוד גישה ברירת מחדל "${defaultPin}" למנהל הקיים "${a.name}" (אפשר לשנות מתוך מסך הניהול).`);
  }
}

module.exports = { pool, migrate };
