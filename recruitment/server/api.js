const express = require('express');
const { pool } = require('./db');
const STATUSES = require('./statuses');

const router = express.Router();

// עוטף handler אסינכרוני כדי שחריגות יעברו ל-error middleware במקום לתקוע את הבקשה
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// אין מסך התחברות: כל בקשה מזהה "מי אני" לפי כותרת x-ambassador-id
// (הבחירה מי אתה נעשית פעם אחת בלקוח מתוך רשימת השגרירים, ונשמרת שם)
router.use(ah(async (req, res, next) => {
  const id = req.headers['x-ambassador-id'];
  if (!id) return next();
  const { rows } = await pool.query('SELECT id, name, phone, is_admin FROM ambassadors WHERE id = $1', [id]);
  if (rows[0]) req.ambassador = rows[0];
  next();
}));

function requireAuth(req, res, next) {
  if (!req.ambassador) return res.status(400).json({ error: 'יש לבחור זהות ("מי אתה") לפני שממשיכים' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.ambassador || !req.ambassador.is_admin) return res.status(403).json({ error: 'פעולה זו מיועדת למנהל בלבד' });
  next();
}

router.get('/statuses', (req, res) => res.json(STATUSES));

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

// מנרמל קלט סיווגים (מחרוזת יחידה, מחרוזת מופרדת בפסיקים, או מערך) לרשימת מזהי קטגוריה,
// תוך יצירת קטגוריות חדשות לפי הצורך
async function resolveCategoryIds(input) {
  let names = [];
  if (Array.isArray(input)) names = input;
  else if (typeof input === 'string') names = input.split(',');
  names = names.map(n => String(n || '').trim()).filter(Boolean);
  const uniqueNames = [...new Set(names)];
  const ids = [];
  for (const name of uniqueNames) {
    const { rows } = await pool.query(
      `INSERT INTO categories (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function setContactCategories(contactId, categoryIds) {
  await pool.query('DELETE FROM contact_categories WHERE contact_id = $1', [contactId]);
  for (const categoryId of categoryIds) {
    await pool.query(
      'INSERT INTO contact_categories (contact_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [contactId, categoryId]
    );
  }
}

const CONTACT_SELECT = `
  SELECT c.id, c.name, c.phone, c.notes, c.status, c.created_at, c.updated_at,
         c.ambassador_candidate, cand.id AS candidate_owner_id, cand.name AS candidate_owner_name,
         amb.id AS ambassador_id, amb.name AS ambassador_name,
         creator.name AS created_by_name,
         COALESCE((
           SELECT json_agg(json_build_object('id', cat.id, 'name', cat.name) ORDER BY cat.name)
           FROM contact_categories cc JOIN categories cat ON cat.id = cc.category_id
           WHERE cc.contact_id = c.id
         ), '[]') AS categories
  FROM contacts c
  LEFT JOIN ambassadors amb ON amb.id = c.ambassador_id
  LEFT JOIN ambassadors creator ON creator.id = c.created_by
  LEFT JOIN ambassadors cand ON cand.id = c.candidate_owner_id
`;

function shapeContact(r) {
  return {
    id: r.id, name: r.name, phone: r.phone, notes: r.notes, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    categories: r.categories || [],
    ambassador: r.ambassador_id ? { id: r.ambassador_id, name: r.ambassador_name } : null,
    createdBy: r.created_by_name || null,
    isAmbassadorCandidate: r.ambassador_candidate,
    candidateOwner: r.candidate_owner_id ? { id: r.candidate_owner_id, name: r.candidate_owner_name } : null
  };
}

// --- contacts ---
// scope=all פתוח לכולם — כל שגריר יכול לעבור על הרשימה המלאה ולסווג/לראות הכל.
// שיוך מחדש לשגריר (assign) והוספה/מחיקה של שגרירים נשארים בהרשאת מנהל בלבד.
router.get('/contacts', requireAuth, ah(async (req, res) => {
  const scope = req.query.scope || 'mine';
  let query = CONTACT_SELECT;
  let params = [];
  if (scope === 'mine') {
    query += ' WHERE c.ambassador_id = $1';
    params = [req.ambassador.id];
  } else if (scope === 'unassigned') {
    query += ' WHERE c.ambassador_id IS NULL';
  } else if (scope === 'candidates') {
    query += ' WHERE c.ambassador_candidate = TRUE';
  } else if (scope !== 'all') {
    return res.status(400).json({ error: 'scope לא תקין' });
  }
  if (req.query.uncategorized === '1') {
    query += (params.length ? ' AND ' : ' WHERE ') + 'NOT EXISTS (SELECT 1 FROM contact_categories cc WHERE cc.contact_id = c.id)';
  }
  query += ' ORDER BY c.created_at DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows.map(shapeContact));
}));

router.post('/contacts', requireAuth, ah(async (req, res) => {
  const { name, phone, notes, categories, ambassadorId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם' });
  let assignTo = req.ambassador.id;
  if (ambassadorId !== undefined) {
    if (!req.ambassador.is_admin) return res.status(403).json({ error: 'רק מנהל יכול לשייך לשגריר אחר' });
    assignTo = ambassadorId || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO contacts (name, phone, notes, ambassador_id, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name.trim(), phone || null, notes || null, assignTo, req.ambassador.id]
  );
  const categoryIds = await resolveCategoryIds(categories);
  if (categoryIds.length) await setContactCategories(rows[0].id, categoryIds);
  const { rows: full } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [rows[0].id]);
  res.status(201).json(shapeContact(full[0]));
}));

// ייבוא מרוכז — למנהל בלבד: מדביקים הרבה שורות בבת אחת (שם / טלפון / קטגוריה (אפשר כמה, מופרד בפסיק) / שגריר-אופציונלי)
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
    const inserted = await pool.query(
      `INSERT INTO contacts (name, phone, notes, ambassador_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, r.phone || null, r.notes || null, ambassadorId, req.ambassador.id]
    );
    const categoryIds = await resolveCategoryIds(r.category);
    if (categoryIds.length) await setContactCategories(inserted.rows[0].id, categoryIds);
    results.push({ name, ok: true, id: inserted.rows[0].id });
  }
  res.json({ results, added: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
}));

// כל שגריר מחובר יכול לערוך כל איש קשר (לא רק את שלו) — עדכון פרטים/סטטוס/מחיקה
// הם חלק מתחזוקת הרשימה המשותפת, בדיוק כמו סיווג וסימון מועמדים לשגרירות.
async function loadContactForEdit(req, res, next) {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  req.contact = rows[0];
  next();
}

router.patch('/contacts/:id', requireAuth, ah(loadContactForEdit), ah(async (req, res) => {
  const { name, phone, notes } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name.trim()); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
  if (notes !== undefined) { updates.push(`notes = $${i++}`); values.push(notes); }
  if (updates.length) {
    updates.push('updated_at = now()');
    values.push(req.params.id);
    await pool.query(`UPDATE contacts SET ${updates.join(', ')} WHERE id = $${i}`, values);
  }
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
}));

// עדכון סיווגים פתוח לכולם — כל שגריר יכול לעבור על הרשימה ולסווג כל איש קשר, לא רק את שלו
router.post('/contacts/:id/categories', requireAuth, ah(async (req, res) => {
  const categoryIds = await resolveCategoryIds(req.body && req.body.categories);
  const { rowCount } = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  await setContactCategories(req.params.id, categoryIds);
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

// מחיקת איש קשר לא רלוונטי מהרשימה — פתוח לכל שגריר מחובר, כחלק מתחזוקת הרשימה המשותפת
router.delete('/contacts/:id', requireAuth, ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  res.json({ ok: true });
}));

// סימון "מועמד/ת לשגרירות": לוקחים אחריות בעצמכם, או משאירים פתוח לשאלה של שגרירים אחרים.
// פתוח לכל זהות — זו בדיוק המטרה: שכל אחד יוכל להציע ולקחת/להעביר הלאה אחריות.
router.post('/contacts/:id/candidate', requireAuth, ah(async (req, res) => {
  const { candidate, owner } = req.body || {};
  const { rowCount } = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  if (candidate === false) {
    await pool.query(
      'UPDATE contacts SET ambassador_candidate = FALSE, candidate_owner_id = NULL, updated_at = now() WHERE id = $1',
      [req.params.id]
    );
  } else {
    const ownerId = owner === 'me' ? req.ambassador.id : null;
    await pool.query(
      'UPDATE contacts SET ambassador_candidate = TRUE, candidate_owner_id = $1, updated_at = now() WHERE id = $2',
      [ownerId, req.params.id]
    );
  }
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
}));

router.get('/contacts/:id/history', requireAuth, ah(async (req, res) => {
  const { rows: crows } = await pool.query('SELECT id FROM contacts WHERE id = $1', [req.params.id]);
  if (!crows[0]) return res.status(404).json({ error: 'איש קשר לא נמצא' });
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

// --- ambassadors ---
// הרשימה עצמה פתוחה לכולם (גם בלי זהות נבחרת עדיין) — היא משמשת גם כמסך "מי אתה?"
router.get('/ambassadors', ah(async (req, res) => {
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
  const { name, phone, isAdmin } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO ambassadors (name, phone, is_admin) VALUES ($1, $2, $3) RETURNING id, name, phone, is_admin',
      [name.trim(), phone || null, !!isAdmin]
    );
    res.status(201).json({ id: rows[0].id, name: rows[0].name, phone: rows[0].phone, isAdmin: rows[0].is_admin, contactCount: 0 });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'כבר קיים שגריר בשם הזה' });
    throw e;
  }
}));

router.patch('/ambassadors/:id', requireAdmin, ah(async (req, res) => {
  const { name, phone, isAdmin } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name.trim()); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
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
