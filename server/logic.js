// ── פונקציות טהורות — הועברו כמעט מילה-במילה מ-Code.gs המקורי ──
// אלה לא נוגעות במסד הנתונים בעצמן; הן מקבלות מערכים (שכבר נטענו) ומחזירות תוצאה מחושבת.

function uid(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
}

function classKey(s) {
  return s.institution ? (s.class + ' - ' + s.institution) : s.class;
}

// כמה תלמיד שילם על דרישה ספציפית
function paidOnDemand(studentId, demandId, payments) {
  return payments
    .filter(p => p.demandIds.includes(demandId) && p.studentIds.includes(studentId))
    .reduce((sum, p) => {
      const a = p.amounts[studentId];
      const share = (a !== undefined) ? (parseFloat(a) || 0) : p.total / Math.max(p.studentIds.length, 1);
      return sum + share;
    }, 0);
}

// זיכוי כללי לתלמיד (תשלומים ללא דרישה)
function generalCredit(studentId, payments) {
  return payments
    .filter(p => p.demandIds.length === 0 && p.studentIds.includes(studentId))
    .reduce((sum, p) => {
      const a = p.amounts[studentId];
      const share = (a !== undefined) ? (parseFloat(a) || 0) : p.total / Math.max(p.studentIds.length, 1);
      return sum + share;
    }, 0);
}

// חוב נטו של תלמיד
function studentDebt(studentId, demands, payments) {
  const fromDemands = demands
    .filter(d => d.studentIds.includes(studentId))
    .reduce((sum, d) => sum + Math.max(0, d.amount - paidOnDemand(studentId, d.id, payments)), 0);
  return Math.max(0, fromDemands - generalCredit(studentId, payments));
}

// זיהוי משפחה אוטומטי לפי טלפון משותף
function phonesOf(s) {
  const norm = p => String(p || '').replace(/[^0-9]/g, '');
  const arr = [];
  const dp = norm(s.dadPhone); if (dp) arr.push(dp);
  const mp = norm(s.momPhone); if (mp) arr.push(mp);
  return arr;
}

function familyGroupIds(studentId, students) {
  const byId = {};
  students.forEach(s => { byId[s.id] = s; });
  const visited = new Set([studentId]);
  const queue = [studentId];
  while (queue.length) {
    const cur = byId[queue.shift()];
    if (!cur) continue;
    const phones = phonesOf(cur);
    if (!phones.length) continue;
    students.forEach(other => {
      if (visited.has(other.id)) return;
      const otherPhones = phonesOf(other);
      if (phones.some(p => otherPhones.includes(p))) {
        visited.add(other.id);
        queue.push(other.id);
      }
    });
  }
  return [...visited];
}

module.exports = { uid, classKey, paidOnDemand, generalCredit, studentDebt, phonesOf, familyGroupIds };
