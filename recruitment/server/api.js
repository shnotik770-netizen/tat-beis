const express = require('express');
const ExcelJS = require('exceljs');
const { pool } = require('./db');
const STATUSES = require('./statuses');
const { hashPin, verifyPin, generateInviteToken } = require('./auth');

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
         selfamb.id AS self_of_ambassador_id, selfamb.name AS self_of_ambassador_name,
         c.invite_token, c.seat_number, c.companion_seat_number, c.attending_with_companion,
         c.invite_greeting_name, c.invite_companion_name,
         COALESCE((
           SELECT json_agg(json_build_object('id', cat.id, 'name', cat.name) ORDER BY cat.name)
           FROM contact_categories cc JOIN categories cat ON cat.id = cc.category_id
           WHERE cc.contact_id = c.id
         ), '[]') AS categories,
         (SELECT COUNT(*)::int FROM contact_comments cm WHERE cm.contact_id = c.id) AS comments_count
  FROM contacts c
  LEFT JOIN ambassadors amb ON amb.id = c.ambassador_id
  LEFT JOIN ambassadors creator ON creator.id = c.created_by
  LEFT JOIN ambassadors cand ON cand.id = c.candidate_owner_id
  LEFT JOIN ambassadors selfamb ON selfamb.id = c.self_of_ambassador_id
`;

function shapeContact(r) {
  return {
    id: r.id, name: r.name, phone: r.phone, notes: r.notes, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    categories: r.categories || [],
    ambassador: r.ambassador_id ? { id: r.ambassador_id, name: r.ambassador_name } : null,
    createdBy: r.created_by_name || null,
    isAmbassadorCandidate: r.ambassador_candidate,
    candidateOwner: r.candidate_owner_id ? { id: r.candidate_owner_id, name: r.candidate_owner_name } : null,
    selfOfAmbassador: r.self_of_ambassador_id ? { id: r.self_of_ambassador_id, name: r.self_of_ambassador_name } : null,
    commentsCount: r.comments_count || 0,
    inviteToken: r.invite_token,
    seatNumber: r.seat_number,
    companionSeatNumber: r.companion_seat_number,
    attendingWithCompanion: r.attending_with_companion,
    inviteGreetingName: r.invite_greeting_name,
    inviteCompanionName: r.invite_companion_name
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

// ייצוא כל הרשימה לאקסל — למנהל בלבד
router.get('/contacts/export.xlsx', requireAdmin, ah(async (req, res) => {
  const { rows } = await pool.query(CONTACT_SELECT + ' ORDER BY c.name');
  const contacts = rows.map(shapeContact);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('אנשי קשר');
  sheet.views = [{ rightToLeft: true }];
  sheet.columns = [
    { header: 'שם', key: 'name', width: 22 },
    { header: 'טלפון', key: 'phone', width: 14 },
    { header: 'סטטוס', key: 'status', width: 22 },
    { header: 'שגריר אחראי', key: 'ambassador', width: 18 },
    { header: 'סיווגים', key: 'categories', width: 26 },
    { header: 'הערות', key: 'notes', width: 30 },
    { header: 'מקום ישיבה', key: 'seat', width: 12 },
    { header: 'מקום לבן/בת הזוג', key: 'cseat', width: 15 },
    { header: 'שם האיש בהזמנה', key: 'greet', width: 20 },
    { header: 'שם האישה בהזמנה', key: 'cname', width: 20 },
    { header: 'מגיע/ה עם בן/בת זוג', key: 'withc', width: 16 },
    { header: 'תאריך הוספה', key: 'created', width: 14 }
  ];
  sheet.getRow(1).font = { bold: true };
  contacts.forEach(c => {
    sheet.addRow({
      name: c.name,
      phone: c.phone || '',
      status: c.status || '',
      ambassador: c.ambassador ? c.ambassador.name : '',
      categories: (c.categories || []).map(cat => cat.name).join(', '),
      notes: c.notes || '',
      seat: c.seatNumber || '',
      cseat: c.companionSeatNumber || '',
      greet: c.inviteGreetingName || '',
      cname: c.inviteCompanionName || '',
      withc: c.attendingWithCompanion === true ? 'כן' : (c.attendingWithCompanion === false ? 'לא' : ''),
      created: c.createdAt ? new Date(c.createdAt).toLocaleDateString('he-IL') : ''
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="anshei-kesher.xlsx"');
  res.send(Buffer.from(buffer));
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
    `INSERT INTO contacts (name, phone, notes, ambassador_id, created_by, invite_token)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name.trim(), phone || null, notes || null, assignTo, req.ambassador.id, generateInviteToken()]
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
      `INSERT INTO contacts (name, phone, notes, ambassador_id, created_by, invite_token)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, r.phone || null, r.notes || null, ambassadorId, req.ambassador.id, generateInviteToken()]
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

// שיבוץ מקומות ישיבה ופרטי ההזמנה האישית — פתוח לכל שגריר מחובר, כמו שאר עריכת אנשי הקשר
router.post('/contacts/:id/seating', requireAuth, ah(async (req, res) => {
  const { seatNumber, companionSeatNumber, greetingName, companionName, attendingWithCompanion } = req.body || {};
  const { rowCount } = await pool.query(
    `UPDATE contacts SET seat_number = $1, companion_seat_number = $2,
       invite_greeting_name = $3, invite_companion_name = $4,
       attending_with_companion = $5, updated_at = now()
     WHERE id = $6`,
    [
      seatNumber || null, companionSeatNumber || null, greetingName || null, companionName || null,
      attendingWithCompanion === true ? true : (attendingWithCompanion === false ? false : null),
      req.params.id
    ]
  );
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
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

// ביטול שיוך עצמי — שגריר שמשויך לאיש קשר יכול לבטל את השיוך שלו (מחזיר אותו ל"לא משויכים").
// שיוך מחדש לשגריר *אחר* נשאר בהרשאת מנהל בלבד (assign).
router.post('/contacts/:id/unassign', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  const contact = rows[0];
  if (!contact) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  if (!req.ambassador.is_admin && contact.ambassador_id !== req.ambassador.id) {
    return res.status(403).json({ error: 'אפשר לבטל שיוך רק לאיש קשר שאתם האחראים עליו' });
  }
  await pool.query('UPDATE contacts SET ambassador_id = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
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
  if (!status) {
    // ביטול הסימון — חוזרים ל"טרם נקבע סטטוס". ההיסטוריה נשארת כתיעוד של מה שכבר קרה.
    await pool.query('UPDATE contacts SET status = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
  } else {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'סטטוס לא מוכר' });
    await pool.query('INSERT INTO status_history (contact_id, status, changed_by) VALUES ($1, $2, $3)', [req.params.id, status, req.ambassador.id]);
    // מי שמעדכן סטטוס לאיש קשר שעדיין לא משויך לאף שגריר — משויך אליו אוטומטית
    if (!req.contact.ambassador_id) {
      await pool.query('UPDATE contacts SET status = $1, ambassador_id = $2, updated_at = now() WHERE id = $3', [status, req.ambassador.id, req.params.id]);
    } else {
      await pool.query('UPDATE contacts SET status = $1, updated_at = now() WHERE id = $2', [status, req.params.id]);
    }
  }
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
}));

// מחיקת איש קשר לא רלוונטי מהרשימה — פתוח לכל שגריר מחובר, כחלק מתחזוקת הרשימה המשותפת
router.delete('/contacts/:id', requireAuth, ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  res.json({ ok: true });
}));

// פעולות מרוכזות על כמה אנשי קשר שנבחרו ביחד ברשימה
router.post('/contacts/bulk-categories', requireAuth, ah(async (req, res) => {
  const { ids, categories } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'לא נבחרו אנשי קשר' });
  const categoryIds = await resolveCategoryIds(categories);
  if (!categoryIds.length) return res.status(400).json({ error: 'יש להזין סיווג אחד לפחות' });
  for (const contactId of ids) {
    for (const categoryId of categoryIds) {
      await pool.query(
        'INSERT INTO contact_categories (contact_id, category_id) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM contacts WHERE id = $1) ON CONFLICT DO NOTHING',
        [contactId, categoryId]
      );
    }
  }
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = ANY($1::int[])', [ids]);
  res.json(rows.map(shapeContact));
}));

router.post('/contacts/bulk-delete', requireAuth, ah(async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'לא נבחרו אנשי קשר' });
  const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = ANY($1::int[])', [ids]);
  res.json({ ok: true, deleted: rowCount });
}));

// סימון "זה אני": כל שגריר יכול לסמן איש קשר אחד בלבד ברשימה כמייצג אותו עצמו
// (למשל אם הוא הופיע ברשימה המקורית לפני שהצטרף כשגריר). מוסר אוטומטית מכל איש קשר אחר שסימן קודם.
router.post('/contacts/:id/self', requireAuth, ah(async (req, res) => {
  const { self } = req.body || {};
  const { rowCount } = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  if (self === false) {
    await pool.query(
      'UPDATE contacts SET self_of_ambassador_id = NULL, updated_at = now() WHERE id = $1 AND self_of_ambassador_id = $2',
      [req.params.id, req.ambassador.id]
    );
  } else {
    await pool.query(
      'UPDATE contacts SET self_of_ambassador_id = NULL, updated_at = now() WHERE self_of_ambassador_id = $1',
      [req.ambassador.id]
    );
    await pool.query(
      'UPDATE contacts SET self_of_ambassador_id = $1, updated_at = now() WHERE id = $2',
      [req.ambassador.id, req.params.id]
    );
  }
  const { rows } = await pool.query(CONTACT_SELECT + ' WHERE c.id = $1', [req.params.id]);
  res.json(shapeContact(rows[0]));
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
    `SELECT h.status, h.changed_at, COALESCE(a.name, 'אישור עצמי של המוזמן/ת') AS changed_by
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

// שיח פנימי לכל איש קשר — "מי מכיר את זה?" וכו'. פתוח לכולם, כמו שאר תחזוקת הרשימה המשותפת.
router.get('/contacts/:id/comments', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cm.id, cm.message, cm.created_at, cm.ambassador_id, a.name AS ambassador_name
     FROM contact_comments cm LEFT JOIN ambassadors a ON a.id = cm.ambassador_id
     WHERE cm.contact_id = $1 ORDER BY cm.created_at ASC`,
    [req.params.id]
  );
  res.json(rows.map(r => ({
    id: r.id, message: r.message, createdAt: r.created_at,
    ambassador: r.ambassador_id ? { id: r.ambassador_id, name: r.ambassador_name } : null
  })));
}));

router.post('/contacts/:id/comments', requireAuth, ah(async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'יש לכתוב הודעה' });
  const { rowCount } = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  const { rows } = await pool.query(
    'INSERT INTO contact_comments (contact_id, ambassador_id, message) VALUES ($1, $2, $3) RETURNING id, message, created_at',
    [req.params.id, req.ambassador.id, message.trim()]
  );
  res.status(201).json({
    id: rows[0].id, message: rows[0].message, createdAt: rows[0].created_at,
    ambassador: { id: req.ambassador.id, name: req.ambassador.name }
  });
}));

router.delete('/contacts/:id/comments/:commentId', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT ambassador_id FROM contact_comments WHERE id = $1 AND contact_id = $2', [req.params.commentId, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'הודעה לא נמצאה' });
  if (!req.ambassador.is_admin && rows[0].ambassador_id !== req.ambassador.id) {
    return res.status(403).json({ error: 'אפשר למחוק רק הודעה שכתבתם בעצמכם' });
  }
  await pool.query('DELETE FROM contact_comments WHERE id = $1', [req.params.commentId]);
  res.json({ ok: true });
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

// בדיקת קוד גישה — נקודת קצה פתוחה (משמשת את מסך "מי אתה?" לפני שיש זהות בכלל).
// לשגריר רגיל (לא מנהל) אין קוד בכלל, אז הבדיקה עוברת אוטומטית.
router.post('/ambassadors/:id/verify-pin', ah(async (req, res) => {
  const { pin } = req.body || {};
  const { rows } = await pool.query('SELECT is_admin, pin_hash FROM ambassadors WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'שגריר לא נמצא' });
  if (!rows[0].is_admin) return res.json({ ok: true });
  const ok = verifyPin(pin, rows[0].pin_hash);
  if (!ok) return res.status(401).json({ ok: false, error: 'קוד גישה שגוי' });
  res.json({ ok: true });
}));

router.post('/ambassadors', requireAdmin, ah(async (req, res) => {
  const { name, phone, isAdmin, pin } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם' });
  if (isAdmin && !pin) return res.status(400).json({ error: 'יש להגדיר קוד גישה למנהל' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO ambassadors (name, phone, is_admin, pin_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, phone, is_admin',
      [name.trim(), phone || null, !!isAdmin, isAdmin ? hashPin(pin) : null]
    );
    res.status(201).json({ id: rows[0].id, name: rows[0].name, phone: rows[0].phone, isAdmin: rows[0].is_admin, contactCount: 0 });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'כבר קיים שגריר בשם הזה' });
    throw e;
  }
}));

router.patch('/ambassadors/:id', requireAdmin, ah(async (req, res) => {
  const { name, phone, isAdmin, pin } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name.trim()); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
  if (isAdmin !== undefined) { updates.push(`is_admin = $${i++}`); values.push(!!isAdmin); }
  if (pin) { updates.push(`pin_hash = $${i++}`); values.push(hashPin(pin)); }
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

// --- סטטיסטיקה ולוח מובילים (פתוח לכל שגריר, לא רק למנהל — כדי לעודד ולהראות התקדמות) ---
router.get('/stats/ambassadors', requireAuth, ah(async (req, res) => {
  const { rows: ambs } = await pool.query('SELECT id, name FROM ambassadors ORDER BY name');
  const { rows: statusCounts } = await pool.query(`
    SELECT ambassador_id, status, COUNT(*)::int AS cnt
    FROM contacts
    WHERE ambassador_id IS NOT NULL
      AND (self_of_ambassador_id IS NULL OR self_of_ambassador_id <> ambassador_id)
    GROUP BY ambassador_id, status
  `);
  const { rows: updateCounts } = await pool.query(`
    SELECT changed_by AS ambassador_id, COUNT(*)::int AS cnt
    FROM status_history
    WHERE changed_by IS NOT NULL
    GROUP BY changed_by
  `);
  const byAmb = new Map(ambs.map(a => [a.id, { id: a.id, name: a.name, total: 0, byStatus: {}, updatesCount: 0 }]));
  for (const row of statusCounts) {
    const entry = byAmb.get(row.ambassador_id);
    if (!entry) continue;
    const key = row.status || 'טרם נקבע סטטוס';
    entry.byStatus[key] = (entry.byStatus[key] || 0) + row.cnt;
    entry.total += row.cnt;
  }
  for (const row of updateCounts) {
    const entry = byAmb.get(row.ambassador_id);
    if (entry) entry.updatesCount = row.cnt;
  }
  res.json(Array.from(byAmb.values()));
}));

router.get('/stats/timeline', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT date_trunc('day', first_time) AS day, COUNT(*)::int AS cnt
    FROM (
      SELECT contact_id, MIN(changed_at) AS first_time
      FROM status_history
      WHERE status = 'מגיע לאירוע'
      GROUP BY contact_id
    ) t
    GROUP BY day
    ORDER BY day
  `);
  let cumulative = 0;
  const points = rows.map(r => {
    cumulative += r.cnt;
    return { day: r.day, count: r.cnt, cumulative };
  });
  res.json(points);
}));

// --- הזמנה אישית ציבורית (ללא זהות שגריר בכלל — מזוהה רק לפי הטוקן שבקישור) ---
// המוזמן/ת מקבל/ת קישור אישי (/invite/<token>) שמראה לו הזמנה, שם, מקום ישיבה, ומאפשר אישור הגעה.
router.get('/public/invite/:token', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT name, status, seat_number, companion_seat_number, attending_with_companion,
            invite_greeting_name, invite_companion_name
     FROM contacts WHERE invite_token = $1`,
    [req.params.token]
  );
  if (!rows[0]) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  const c = rows[0];
  res.json({
    name: c.name,
    status: c.status,
    seatNumber: c.seat_number,
    companionSeatNumber: c.companion_seat_number,
    attendingWithCompanion: c.attending_with_companion,
    greetingName: c.invite_greeting_name,
    companionName: c.invite_companion_name
  });
}));

router.post('/public/invite/:token/rsvp', ah(async (req, res) => {
  const { attending, withCompanion } = req.body || {};
  const { rows } = await pool.query('SELECT id FROM contacts WHERE invite_token = $1', [req.params.token]);
  if (!rows[0]) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  const contactId = rows[0].id;

  let status;
  if (attending === true) status = 'מגיע לאירוע';
  else if (attending === 'donate') status = 'לא יכול להגיע אבל רוצה לתרום';
  else if (attending === false) status = 'לא יכול להגיע לאירוע';
  else return res.status(400).json({ error: 'תשובה לא מוכרת' });

  await pool.query('INSERT INTO status_history (contact_id, status, changed_by) VALUES ($1, $2, NULL)', [contactId, status]);
  await pool.query(
    'UPDATE contacts SET status = $1, attending_with_companion = $2, updated_at = now() WHERE id = $3',
    [status, attending === true ? !!withCompanion : null, contactId]
  );

  const { rows: full } = await pool.query(
    `SELECT name, status, seat_number, companion_seat_number, attending_with_companion,
            invite_greeting_name, invite_companion_name
     FROM contacts WHERE id = $1`,
    [contactId]
  );
  const c = full[0];
  res.json({
    name: c.name,
    status: c.status,
    seatNumber: c.seat_number,
    companionSeatNumber: c.companion_seat_number,
    attendingWithCompanion: c.attending_with_companion,
    greetingName: c.invite_greeting_name,
    companionName: c.invite_companion_name
  });
}));

module.exports = router;
