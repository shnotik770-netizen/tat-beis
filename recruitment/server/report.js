// דוח מפורט משותף לכל אנשי הקשר — משמש גם לייצוא לאקסל וגם לסנכרון עם גוגל שיטס,
// כדי ששתי הפלטים תמיד יראו בדיוק אותם עמודות ואותם נתונים.
const CONTACT_SELECT = `
  SELECT c.id, c.name, c.phone, c.notes, c.status, c.created_at, c.updated_at,
         amb.id AS ambassador_id, amb.name AS ambassador_name,
         c.seat_number, c.companion_seat_number, c.attending_with_companion,
         c.invite_greeting_name, c.invite_companion_name,
         COALESCE((
           SELECT json_agg(json_build_object('id', cat.id, 'name', cat.name) ORDER BY cat.name)
           FROM contact_categories cc JOIN categories cat ON cat.id = cc.category_id
           WHERE cc.contact_id = c.id
         ), '[]') AS categories
  FROM contacts c
  LEFT JOIN ambassadors amb ON amb.id = c.ambassador_id
`;

const REPORT_COLUMNS = [
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

function contactToRow(r) {
  return {
    name: r.name,
    phone: r.phone || '',
    status: r.status || '',
    ambassador: r.ambassador_name || '',
    categories: (r.categories || []).map(cat => cat.name).join(', '),
    notes: r.notes || '',
    seat: r.seat_number || '',
    cseat: r.companion_seat_number || '',
    greet: r.invite_greeting_name || '',
    cname: r.invite_companion_name || '',
    withc: r.attending_with_companion === true ? 'כן' : (r.attending_with_companion === false ? 'לא' : ''),
    created: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : ''
  };
}

async function fetchReportRows(pool) {
  const { rows } = await pool.query(CONTACT_SELECT + ' ORDER BY c.name');
  return rows.map(contactToRow);
}

module.exports = { REPORT_COLUMNS, fetchReportRows };
