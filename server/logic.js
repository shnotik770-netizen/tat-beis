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

// נירמול טלפון לספרות בלבד בפורמט מקומי אחיד (0XXXXXXXXX) — מזהה קידומת בינ"ל (972/00972)
// וחוסר 0 מוביל, כך שמספר שהוזן בכל וריאציה (551234567 / 972-55-669-8745 / 058-558-669-1) מתנרמל לאותו ערך
function normPhoneDigits(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00972')) d = d.slice(5);
  else if (d.startsWith('972')) d = d.slice(3);
  if (!d.startsWith('0')) d = '0' + d;
  return d;
}

// עיצוב טלפון לתצוגה/שמירה בכלל קבוע: 05X-XXXXXXX (נייד) או 0X-XXXXXXX (קווי)
function formatPhoneIL(p) {
  const d = normPhoneDigits(p);
  if (!d) return '';
  if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3);
  if (d.length === 9) return d.slice(0, 2) + '-' + d.slice(2);
  return d;
}

// זיהוי משפחה אוטומטי לפי טלפון משותף
function phonesOf(s) {
  const arr = [];
  const dp = normPhoneDigits(s.dadPhone); if (dp) arr.push(dp);
  const mp = normPhoneDigits(s.momPhone); if (mp) arr.push(mp);
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

// ממזג פרטי הורים (וכתובת) בין בני משפחה (מזוהים לפי טלפון משותף): אם לתלמיד אחד יש רק שם+טלפון
// של הורה אחד ולאח/אחות שלו יש את פרטי ההורה השני או את הכתובת, בני המשפחה "משלימים" זה את זה.
// ממלא רק שדות ריקים — לעולם לא דורס ערך קיים, גם אם הוא שונה בין בני המשפחה.
function mergeFamilyParentInfo(members) {
  let dadName = '', dadPhone = '', momName = '', momPhone = '', address = '';
  members.forEach(m => {
    if (!dadName && m.dadName) dadName = m.dadName;
    if (!dadPhone && m.dadPhone) dadPhone = m.dadPhone;
    if (!momName && m.momName) momName = m.momName;
    if (!momPhone && m.momPhone) momPhone = m.momPhone;
    if (!address && m.address) address = m.address;
  });
  return members.map(m => ({
    ...m,
    dadName: m.dadName || dadName,
    dadPhone: m.dadPhone || dadPhone,
    momName: m.momName || momName,
    momPhone: m.momPhone || momPhone,
    address: m.address || address
  }));
}

// מפרש תאריך שהודבק מגיליון אלקטרוני (למשל "05/08/2026") כפורמט ישראלי DD/MM/YYYY במפורש.
// ה-Date המובנה של JS מפרש מחרוזות עם / כפורמט האמריקאי MM/DD/YYYY, מה שהופך "05/08/2026"
// (5 באוגוסט) בטעות ל-8 במאי — לכן יום/חודש מפורקים ידנית ולא מועברים ל-new Date(string).
function parsePastedDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return new Date();
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) {
    let d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    if (!isNaN(dt.getTime()) && dt.getDate() === d && dt.getMonth() === mo - 1) return dt;
  }
  const dt2 = new Date(s);
  return isNaN(dt2.getTime()) ? new Date() : dt2;
}

module.exports = { uid, classKey, paidOnDemand, generalCredit, studentDebt, phonesOf, familyGroupIds, formatPhoneIL, mergeFamilyParentInfo, parsePastedDate };
