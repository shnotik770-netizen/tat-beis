const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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
  console.log('✅ Database schema is up to date.');
}

async function seedAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM ambassadors');
  if (rows[0].c > 0) return;
  const name = process.env.ADMIN_NAME || 'מנהל';
  await pool.query('INSERT INTO ambassadors (name, phone, is_admin) VALUES ($1, $2, TRUE)', [name, null]);
  console.log(`👤 נוצר שגריר-מנהל ראשוני: "${name}". אפשר לבחור אותו מיד ממסך "מי אתה?" ולהוסיף משם שגרירים נוספים.`);
}

module.exports = { pool, migrate };
