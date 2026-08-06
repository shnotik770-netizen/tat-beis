const { pool } = require('./db');

// ── ממירי שורה → אובייקט (אותם שמות שדות בדיוק כמו ב-Code.gs המקורי) ──
function rowToStudent(r) {
  return {
    id: r.id, lastName: r.last_name, firstName: r.first_name, class: r.class,
    institution: r.institution, dadName: r.dad_name, dadPhone: r.dad_phone,
    momName: r.mom_name, momPhone: r.mom_phone, categoryIds: r.category_ids || [],
    active: r.active, tz: r.tz, birthDate: r.birth_date, address: r.address
  };
}
function rowToCategory(r) {
  return { id: r.id, name: r.name, desc: r.description, studentIds: r.student_ids || [] };
}
function fmtD(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
function rowToDemand(r) {
  return {
    id: r.id, title: r.title, amount: parseFloat(r.amount) || 0,
    createdDate: fmtD(r.created_date), dueDate: fmtD(r.due_date),
    categoryIds: r.category_ids || [], studentIds: r.student_ids || [],
    notes: r.notes, isFamily: !!r.is_family, familyGroupId: r.family_group_id || ''
  };
}
function rowToPayment(r) {
  return {
    id: r.id, date: fmtD(r.date), payer: r.payer,
    studentIds: r.student_ids || [], demandIds: r.demand_ids || [],
    total: parseFloat(r.total) || 0, amounts: r.amounts || {},
    method: r.method, notes: r.notes
  };
}
function rowToPending(r) {
  return {
    id: r.id, date: fmtD(r.date), payer: r.payer,
    amount: parseFloat(r.amount) || 0, method: r.method, notes: r.notes
  };
}

async function getAllStudents() {
  const { rows } = await pool.query('SELECT * FROM students ORDER BY created_at');
  return rows.map(rowToStudent);
}
async function getAllCategories() {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY created_at');
  return rows.map(rowToCategory);
}
async function getAllDemands() {
  const { rows } = await pool.query('SELECT * FROM demands ORDER BY created_date');
  return rows.map(rowToDemand);
}
async function getAllPayments() {
  const { rows } = await pool.query('SELECT * FROM payments ORDER BY date');
  return rows.map(rowToPayment);
}
async function getAllPending() {
  const { rows } = await pool.query('SELECT * FROM pending_payments ORDER BY date');
  return rows.map(rowToPending);
}

module.exports = {
  rowToStudent, rowToCategory, rowToDemand, rowToPayment, rowToPending, fmtD,
  getAllStudents, getAllCategories, getAllDemands, getAllPayments, getAllPending
};
