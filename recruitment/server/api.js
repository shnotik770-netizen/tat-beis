const express = require('express');
const { pool } = require('./db');
const { hashPin, verifyPin, generateToken } = require('./auth');
const STATUSES = require('./statuses');

const router = express.Router();

// עוטף handler אסינכרוני כדי שחריגות יעברו ל-error middleware במקום לתקוע את הבקשה
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- session middleware ---
router.use(ah(async (req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (!token) return next();
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.phone, a.is_admin FROM sessions s
     JOIN ambassadors a ON a.id = s.ambassador_id
     WHERE s.token = $1`,
    [token]
  );
  if (rows[0]) {
    req.ambassador = rows[0];
    req.token = token;
  }
  next();
}));

function requireAuth(req, res, next) {
  if (!req.ambassador) return res.status(401).json({ error: 'נדרשת התחברות' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.ambassador || !req.ambassador.is_admin) return res.status(403).json({ error: 'פעולה זו מיועדת למנהל בלבד' });
  next();
}

router.get('/statuses', (req, res) => res.json(STATUSES));

// --- auth ---
router.post('/login', ah(async (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'יש להזין שם וקוד כניסה' });
  const { rows } = await pool.query('SELECT * FROM ambassadors WHERE lower(name) = lower($1)', [String(name).trim()]);
  const amb = rows[0];
  if (!amb || !verifyPin(pin, amb.pin_hash)) {
    return res.status(401).json({ error: 'שם או קוד כניסה שגויים' });
  }
  const token = generateToken();
  await pool.query('INSERT INTO sessions (token, ambassador_id) VALUES ($1, $2)', [token, amb.id]);
  res.json({ token, ambassador: { id: amb.id, name: amb.name, phone: amb.phone, isAdmin: amb.is_admin } });
}));

router.post('/logout', requireAuth, ah(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.ambassador.id, name: req.ambassador.name, phone: req.ambassador.phone, isAdmin: req.ambassador.is_admin });
});

router.patch('/me', requireAuth, ah(async (req, res) => {
  const { pin, phone } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (pin) { updates.push(`pin_hash = $${i++}`); values.push(hashPin(pin)); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
  if (!updates.length) return res.json({ ok: true });
  values.push(req.ambassador.id);
  await pool.query(`UPDATE ambassadors SET ${updates.join(', ')} WHERE id = $${i}`, values);
  res.json({ ok: true });
}));

// --- categories ---
router.get('/categories', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM categories ORDER BY name');
  res.json(rows);
}));

router.post('/categories', requireAuth, ah(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם קטגוריה' });
  const { rows } = await pool.query(
    `INSERT INTO categories (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [name.trim()]
  );
  res.json(rows[0]);
}));

router.delete('/categories/:id', requireAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

async function resolveCategoryId(name) {
  if (!name || !String(name).trim()) return null;
  const trimmed = String(name).trim();
  const { rows } = await pool.query(
    `INSERT INTO categories (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [trimmed]
  );
  return rows[0].id;
}

const CONTACT_SELECT = `
  SELECT c.id, c.name, c.phone, c.notes, c.status, c.created_at, c.updated_at,
         cat.id AS category_id, cat.name AS category_name,
         amb.id AS ambassador_id, amb.name AS ambassador_name,
         creator.name AS created_by_name
  FROM contacts c
  LEFT JOIN categories cat ON cat.id = c.category_id
  LEFT JOIN ambassadors amb ON amb.id = c.ambassador_id
  LEFT JOIN ambassadors creator ON creator.id = c.created_by
`;

function shapeContact(r) {
  return {
    id: r.id, name: r.name, phone: r.phone, notes: r.notes, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
    ambassador: r.ambassador_id ? { id: r.ambassador_id, name: r.ambassador_name } : null,
    createdBy: r.created_by_name || null
  };
}

// --- contacts ---
router.get('/contacts', requireAuth, ah(async (req, res) => {
  const scope = req.query.scope || 'mine';
  if (scope === 'all' && !req.ambassador.is_admin) {
    return res.status(403).json({ error: 'צפייה ברשימה המלאה מיועדת למנהל בלבד' });
  }
  let query = CONTACT_SELECT;
  let params = [];
  if (scope === 'mine') {
    query += ' WHERE c.ambassador_id = $1';
    params = [req.ambassador.id];
  } else if (scope === 'unassigned') {
    query += ' WHERE c.ambassador_id IS NULL';
  } else if (scope !== 'all') {
    return res.status(400).json({ error: 'scope לא תקין' });
  }
  query += ' ORDER BY c.created_at DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows.map(shapeContact));
}));

router.post('/contacts', requireAuth, ah(async (req, res) => {
  const { name, phone, notes, category, ambassadorId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם' });
  const categoryId = await resolveCategoryId(category);
  let assignTo = req.ambassador.id;
  if (ambassadorId !== undefined) {
    if (!req.ambassador.is_admin) return res.status(403).json({ error: 'רק מנהל יכול לשייך לשגריר אחר' });
    assignTo = ambassadorId || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO contacts (name, phone, notes, category_id, ambassador_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name.trim(), phone || null, notes || null, categoryId, assignTo, req.ambassador.id]
  );
  const { rows: full } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [rows[0].id]);
  res.status(201).json(shapeContact(full[0]));
}));

// ייבוא מרוכז — למנהל בלבד: מדביקים הרבה שורות בבת אחת (שם / טלפון / קטגוריה / שגריר-אופציונלי)
router.post('/contacts/bulk-import', requireAdmin, ah(async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'לא נשלחו שורות לייבוא' });
  const ambRows = (await pool.query('SELECT id, name FROM ambassadors')).rows;
  const ambByName = new Map(ambRows.map(a => [a.name.trim().toLowerCase(), a.id]));
  const results = [];
  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name) { results.push({ name: r.name || '', ok: false, error: 'שם חסר' }); continue; }
    let ambassadorId = null;
    if (r.ambassador && r.ambassador.trim()) {
      const found = ambByName.get(r.ambassador.trim().toLowerCase());
      if (!found) { results.push({ name, ok: false, error: `שגריר "${r.ambassador}" לא נמצא` }); continue; }
      ambassadorId = found;
    }
    const categoryId = await resolveCategoryId(r.category);
    const inserted = await pool.query(
      `INSERT INTO contacts (name, phone, notes, category_id, ambassador_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, r.phone || null, r.notes || null, categoryId, ambassadorId, req.ambassador.id]
    );
    results.push({ name, ok: true, id: inserted.rows[0].id });
  }
  res.json({ results, added: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
}));

async function loadContactForEdit(req, res, next) {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  const contact = rows[0];
  if (!contact) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  if (!req.ambassador.is_admin && contact.ambassador_id !== req.ambassador.id) {
    return res.status(403).json({ error: 'אין הרשאה לערוך איש קשר זה' });
  }
  req.contact = contact;
  next();
}

router.patch('/contacts/:id', requireAuth, ah(loadContactForEdit), ah(async (req, res) => {
  const { name, phone, notes, category } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name.trim()); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
  if (notes !== undefined) { updates.push(`notes = $${i++}`); values.push(notes); }
  if (category !== undefined) {
    const categoryId = await resolveCategoryId(category);
    updates.push(`category_id = $${i++}`); values.push(categoryId);
  }
  if (updates.length) {
    updates.push('updated_at = now()');
    values.push(req.params.id);
    await pool.query(`UPDATE contacts SET ${updates.join(', ')} WHERE id = $${i}`, values);
  }
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
}));

router.post('/contacts/:id/claim', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  const contact = rows[0];
  if (!contact) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  if (contact.ambassador_id) return res.status(409).json({ error: 'איש קשר זה כבר משויך לשגריר אחר' });
  await pool.query('UPDATE contacts SET ambassador_id = $1, updated_at = now() WHERE id = $2', [req.ambassador.id, req.params.id]);
  const { rows: full } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(full[0]));
}));

router.post('/contacts/:id/assign', requireAdmin, ah(async (req, res) => {
  const { ambassadorId } = req.body || {};
  const { rowCount } = await pool.query('UPDATE contacts SET ambassador_id = $1, updated_at = now() WHERE id = $2', [ambassadorId || null, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
}));

router.post('/contacts/:id/status', requireAuth, ah(loadContactForEdit), ah(async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'סטטוס לא מוכר' });
  await pool.query('INSERT INTO status_history (contact_id, status, changed_by) VALUES ($1, $2, $3)', [req.params.id, status, req.ambassador.id]);
  await pool.query('UPDATE contacts SET status = $1, updated_at = now() WHERE id = $2', [status, req.params.id]);
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
}));

router.get('/contacts/:id/history', requireAuth, ah(async (req, res) => {
  const { rows: crows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  const contact = crows[0];
  if (!contact) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  if (!req.ambassador.is_admin && contact.ambassador_id !== req.ambassador.id) {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  const { rows } = await pool.query(
    `SELECT h.status, h.changed_at, a.name AS changed_by
     FROM status_history h LEFT JOIN ambassadors a ON a.id = h.changed_by
     WHERE h.contact_id = $1 ORDER BY h.changed_at ASC`,
    [req.params.id]
  );
  res.json({
    history: rows,
    initialStatus: rows[0] ? rows[0].status : null,
    previousStatus: rows.length > 1 ? rows[rows.length - 2].status : null,
    currentStatus: rows.length ? rows[rows.length - 1].status : null
  });
}));

// --- ambassadors (admin) ---
router.get('/ambassadors', requireAdmin, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.id, a.name, a.phone, a.is_admin,
           COUNT(c.id)::int AS contact_count
    FROM ambassadors a
    LEFT JOIN contacts c ON c.ambassador_id = a.id
    GROUP BY a.id
    ORDER BY a.name
  `);
  res.json(rows.map(r => ({ id: r.id, name: r.name, phone: r.phone, isAdmin: r.is_admin, contactCount: r.contact_count })));
}));

router.post('/ambassadors', requireAdmin, ah(async (req, res) => {
  const { name, phone, pin, isAdmin } = req.body || {};
  if (!name || !name.trim() || !pin) return res.status(400).json({ error: 'יש להזין שם וקוד כניסה' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO ambassadors (name, phone, pin_hash, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, name, phone, is_admin',
      [name.trim(), phone || null, hashPin(pin), !!isAdmin]
    );
    res.status(201).json({ id: rows[0].id, name: rows[0].name, phone: rows[0].phone, isAdmin: rows[0].is_admin, contactCount: 0 });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'כבר קיים שגריר בשם הזה' });
    throw e;
  }
}));

router.patch('/ambassadors/:id', requireAdmin, ah(async (req, res) => {
  const { name, phone, pin, isAdmin } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name.trim()); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
  if (pin) { updates.push(`pin_hash = $${i++}`); values.push(hashPin(pin)); }
  if (isAdmin !== undefined) { updates.push(`is_admin = $${i++}`); values.push(!!isAdmin); }
  if (!updates.length) return res.json({ ok: true });
  values.push(req.params.id);
  await pool.query(`UPDATE ambassadors SET ${updates.join(', ')} WHERE id = $${i}`, values);
  res.json({ ok: true });
}));

router.delete('/ambassadors/:id', requireAdmin, ah(async (req, res) => {
  if (String(req.ambassador.id) === String(req.params.id)) {
    return res.status(400).json({ error: 'לא ניתן למחוק את המשתמש המחובר' });
  }
  await pool.query('UPDATE contacts SET ambassador_id = NULL WHERE ambassador_id = $1', [req.params.id]);
  await pool.query('DELETE FROM ambassadors WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
