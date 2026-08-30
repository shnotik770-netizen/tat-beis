const { pool } = require('./db');
const logic = require('./logic');
const da = require('./db-access');

// ══════════════════════════════════════════════════════════════
// אבחון
// ══════════════════════════════════════════════════════════════
async function pingTest() {
  try {
    const counts = {};
    for (const t of ['students', 'categories', 'demands', 'payments', 'pending_payments']) {
      const { rows } = await pool.query(`SELECT COUNT(*) FROM ${t}`);
      counts[t] = { rows: parseInt(rows[0].count, 10) };
    }
    return { ok: true, time: new Date().toString(), sheets: counts };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
// קריאת כל הנתונים
// ══════════════════════════════════════════════════════════════
async function getAllData() {
  const [students, categories, demands, payments, pending] = await Promise.all([
    da.getAllStudents(), da.getAllCategories(), da.getAllDemands(), da.getAllPayments(), da.getAllPending()
  ]);
  const classes = [...new Set(students.map(s => logic.classKey(s)).filter(Boolean))].sort();
  return { students, categories, demands, payments, pending, classes };
}

// ══════════════════════════════════════════════════════════════
// תלמידים
// ══════════════════════════════════════════════════════════════
async function addStudent(data) {
  const existing = await da.getAllStudents();
  if (existing.some(s => s.firstName === data.firstName && s.lastName === data.lastName && s.class === data.class && (s.institution || '') === (data.institution || '')))
    return { ok: false, err: 'תלמיד כזה כבר קיים' };

  const id = logic.uid('S');
  await pool.query(
    `INSERT INTO students (id, last_name, first_name, class, institution, dad_name, dad_phone, mom_name, mom_phone, category_ids, active, tz, birth_date, address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'כן',$11,$12,$13)`,
    [id, data.lastName || '', data.firstName || '', data.class || '', data.institution || '',
     data.dadName || '', logic.formatPhoneIL(data.dadPhone), data.momName || '', logic.formatPhoneIL(data.momPhone),
     data.categoryIds || [], data.tz || '', data.birthDate || '', data.address || '']
  );
  await syncStudentCats(id, data.categoryIds || [], []);

  // השלמת פרטי הורים בין בני משפחה (טלפון משותף — מספיק הורה אחד תואם), משני הכיוונים
  const allStudents = await da.getAllStudents();
  await mergeFamilyParentInfoFor(id, allStudents);
  return { ok: true, id };
}

async function updateStudent(data) {
  const dadPhone = logic.formatPhoneIL(data.dadPhone);
  const momPhone = logic.formatPhoneIL(data.momPhone);
  const { rowCount } = await pool.query(
    `UPDATE students SET last_name=$2, first_name=$3, class=$4, institution=$5, dad_name=$6, dad_phone=$7,
       mom_name=$8, mom_phone=$9, category_ids=$10, active=$11, tz=$12, birth_date=$13, address=$14
     WHERE id=$1`,
    [data.id, data.lastName || '', data.firstName || '', data.class || '', data.institution || '',
     data.dadName || '', dadPhone, data.momName || '', momPhone,
     data.categoryIds || [], data.active || 'כן', data.tz || '', data.birthDate || '', data.address || '']
  );
  if (!rowCount) return { ok: false, err: 'תלמיד לא נמצא' };

  const { rows: oldRows } = await pool.query('SELECT category_ids FROM students WHERE id=$1', [data.id]);
  await syncStudentCats(data.id, data.categoryIds || [], (oldRows[0] && oldRows[0].category_ids) || []);

  // השלמת פרטי הורים בין בני משפחה (טלפון משותף — מספיק הורה אחד תואם): ממלא רק שדות ריקים בשני הכיוונים
  const allStudents = await da.getAllStudents();
  await mergeFamilyParentInfoFor(data.id, allStudents);
  return { ok: true };
}

// מפעיל את מיזוג פרטי ההורים על קבוצת המשפחה של תלמיד נתון וכותב רק שורות שבאמת השתנו
async function mergeFamilyParentInfoFor(studentId, allStudents) {
  const familyIds = logic.familyGroupIds(studentId, allStudents);
  if (familyIds.length < 2) return 0;
  const byId = {};
  allStudents.forEach(s => { byId[s.id] = s; });
  const members = familyIds.map(fid => byId[fid]).filter(Boolean);
  const merged = logic.mergeFamilyParentInfo(members);
  let updated = 0;
  for (const m of merged) {
    const orig = byId[m.id];
    if (m.dadName !== orig.dadName || m.dadPhone !== orig.dadPhone || m.momName !== orig.momName || m.momPhone !== orig.momPhone || m.address !== orig.address) {
      await pool.query('UPDATE students SET dad_name=$2, dad_phone=$3, mom_name=$4, mom_phone=$5, address=$6 WHERE id=$1',
        [m.id, m.dadName, m.dadPhone, m.momName, m.momPhone, m.address]);
      updated++;
    }
  }
  return updated;
}

// סריקה חד-פעמית (ניתנת להפעלה חוזרת בבטחה) שמשלימה פרטי הורים חסרים בין בני משפחה בכל בסיס הנתונים
async function backfillFamilyParentInfo() {
  const allStudents = await da.getAllStudents();
  const visited = new Set();
  let updated = 0;
  for (const s of allStudents) {
    if (visited.has(s.id)) continue;
    const familyIds = logic.familyGroupIds(s.id, allStudents);
    familyIds.forEach(fid => visited.add(fid));
    updated += await mergeFamilyParentInfoFor(s.id, allStudents);
  }
  return { ok: true, updated };
}

async function deleteStudent(id) {
  const { rowCount } = await pool.query('DELETE FROM students WHERE id=$1', [id]);
  return { ok: !!rowCount };
}

async function importStudentsFromPaste(rawText) {
  const existing = await da.getAllStudents();
  const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0, skippedReasons = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let cells = line.includes('\t') ? line.split('\t') : line.split(',');
    cells = cells.map(c => (c || '').trim());
    while (cells.length < 12) cells.push('');
    const [lastName, firstName, cls, activeRaw, dadName, dadPhone, momName, momPhone, tz, birthDate, address, institution] = cells;

    if (!lastName && !firstName) { skipped++; skippedReasons.push(`שורה ${idx + 1}: אין שם`); continue; }
    if (!dadPhone && !momPhone) { skipped++; skippedReasons.push(`שורה ${idx + 1}: אין טלפון הורה`); continue; }
    if (existing.some(s => s.firstName === firstName && s.lastName === lastName && s.class === cls && (s.institution || '') === (institution || ''))) {
      skipped++; skippedReasons.push(`שורה ${idx + 1}: ${firstName} ${lastName} כבר קיים`); continue;
    }
    const activeClean = (activeRaw || '').trim();
    const activeVal = (activeClean === 'לא' || activeClean === 'no' || activeClean === '0') ? 'לא' : 'כן';

    await pool.query(
      `INSERT INTO students (id, last_name, first_name, class, institution, dad_name, dad_phone, mom_name, mom_phone, active, tz, birth_date, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [logic.uid('S'), lastName || '', firstName || '', cls || '', institution || '', dadName || '', logic.formatPhoneIL(dadPhone), momName || '', logic.formatPhoneIL(momPhone), activeVal, tz || '', birthDate || '', address || '']
    );
    added++;
  }
  if (added) await backfillFamilyParentInfo(); // משלים פרטי הורים חסרים בין אחים שנוספו/קיימים
  return { ok: true, added, skipped, skippedReasons: skippedReasons.slice(0, 20) };
}

async function syncStudentCats(studentId, newCats, oldCats) {
  const cats = await da.getAllCategories();
  for (const c of cats) {
    let ids = c.studentIds;
    let changed = false;
    if (newCats.includes(c.id) && !ids.includes(studentId)) { ids = [...ids, studentId]; changed = true; }
    if (!newCats.includes(c.id) && oldCats.includes(c.id)) { ids = ids.filter(x => x !== studentId); changed = true; }
    if (changed) await pool.query('UPDATE categories SET student_ids=$2 WHERE id=$1', [c.id, ids]);
  }
}

// ══════════════════════════════════════════════════════════════
// סיווגים
// ══════════════════════════════════════════════════════════════
async function addCategory(data) {
  const id = logic.uid('C');
  await pool.query('INSERT INTO categories (id, name, description, student_ids) VALUES ($1,$2,$3,$4)',
    [id, data.name || '', data.desc || '', data.studentIds || []]);
  await syncCatStudents(id, data.studentIds || [], []);
  return { ok: true, id };
}
async function updateCategory(data) {
  const { rows } = await pool.query('SELECT student_ids FROM categories WHERE id=$1', [data.id]);
  if (!rows.length) return { ok: false };
  const oldIds = rows[0].student_ids || [];
  await pool.query('UPDATE categories SET name=$2, description=$3, student_ids=$4 WHERE id=$1',
    [data.id, data.name || '', data.desc || '', data.studentIds || []]);
  await syncCatStudents(data.id, data.studentIds || [], oldIds);
  return { ok: true };
}
async function deleteCategory(id) {
  const { rowCount } = await pool.query('DELETE FROM categories WHERE id=$1', [id]);
  return { ok: !!rowCount };
}
async function syncCatStudents(catId, newIds, oldIds) {
  const students = await da.getAllStudents();
  for (const s of students) {
    let cats = s.categoryIds;
    let changed = false;
    if (newIds.includes(s.id) && !cats.includes(catId)) { cats = [...cats, catId]; changed = true; }
    if (!newIds.includes(s.id) && oldIds.includes(s.id)) { cats = cats.filter(x => x !== catId); changed = true; }
    if (changed) await pool.query('UPDATE students SET category_ids=$2 WHERE id=$1', [s.id, cats]);
  }
}

// ══════════════════════════════════════════════════════════════
// דרישות
// ══════════════════════════════════════════════════════════════
async function addDemand(data) {
  const studentIds = new Set(data.studentIds || []);
  const categories = await da.getAllCategories();
  categories.forEach(c => { if ((data.categoryIds || []).includes(c.id)) c.studentIds.forEach(sid => studentIds.add(sid)); });
  const students = await da.getAllStudents();
  students.forEach(s => { if (s.active === 'כן' && (data.classes || []).includes(logic.classKey(s))) studentIds.add(s.id); });

  const id = logic.uid('D');
  await pool.query(
    `INSERT INTO demands (id, title, amount, created_date, due_date, category_ids, student_ids, notes, is_family)
     VALUES ($1,$2,$3, now(), $4,$5,$6,$7,$8)`,
    [id, data.title || '', parseFloat(data.amount) || 0, data.dueDate ? new Date(data.dueDate) : null,
     data.categoryIds || [], [...studentIds], data.notes || '', !!data.isFamily]
  );
  return { ok: true, id };
}

async function updateDemand(data) {
  const sets = ['title=$2', 'amount=$3', 'due_date=$4', 'notes=$5'];
  const params = [data.id, data.title || '', parseFloat(data.amount) || 0, data.dueDate ? new Date(data.dueDate) : null, data.notes || ''];
  if (data.isFamily !== undefined) { sets.push(`is_family=$${params.length + 1}`); params.push(!!data.isFamily); }
  if (data.studentIds !== undefined) { sets.push(`student_ids=$${params.length + 1}`); params.push(data.studentIds); }
  const { rowCount } = await pool.query(`UPDATE demands SET ${sets.join(', ')} WHERE id=$1`, params);
  return rowCount ? { ok: true } : { ok: false, err: 'דרישה לא נמצאה' };
}

async function removeStudentFromDemand(demandId, studentId) {
  const { rows } = await pool.query('SELECT student_ids FROM demands WHERE id=$1', [demandId]);
  if (!rows.length) return { ok: false };
  const updated = (rows[0].student_ids || []).filter(x => x !== studentId);
  await pool.query('UPDATE demands SET student_ids=$2 WHERE id=$1', [demandId, updated]);
  return { ok: true };
}

async function splitStudentFromDemand(demandId, studentId, newAmount) {
  const { rows } = await pool.query('SELECT * FROM demands WHERE id=$1', [demandId]);
  if (!rows.length) return { ok: false, err: 'דרישה לא נמצאה' };
  const orig = rows[0];
  const remaining = (orig.student_ids || []).filter(x => x !== studentId);
  if (!remaining.length) return { ok: false, err: 'התלמיד היחיד בדרישה זו — אין צורך לפצל, פשוט ערוך את הסכום ישירות' };

  await pool.query('UPDATE demands SET student_ids=$2 WHERE id=$1', [demandId, remaining]);
  await pool.query(
    `INSERT INTO demands (id, title, amount, created_date, due_date, category_ids, student_ids, notes, is_family)
     VALUES ($1,$2,$3, now(), $4, '{}', $5, $6, $7)`,
    [logic.uid('D'), orig.title, parseFloat(newAmount) || 0, orig.due_date, [studentId], orig.notes, orig.is_family]
  );
  return { ok: true };
}

async function addDemandVaried(data) {
  const items = (data.items || []).filter(it => it.studentId && parseFloat(it.amount) > 0);
  if (!items.length) return { ok: false, err: 'לא הוזנו סכומים תקינים' };
  const due = data.dueDate ? new Date(data.dueDate) : null;
  const ids = [];
  for (const it of items) {
    const id = logic.uid('D');
    await pool.query(
      `INSERT INTO demands (id, title, amount, created_date, due_date, category_ids, student_ids, notes, is_family)
       VALUES ($1,$2,$3, now(), $4, '{}', $5, $6, $7)`,
      [id, data.title || '', parseFloat(it.amount) || 0, due, [it.studentId], it.notes || '', !!it.isFamily]
    );
    ids.push(id);
  }
  return { ok: true, count: ids.length, ids };
}

async function deleteDemand(id) {
  const { rowCount } = await pool.query('DELETE FROM demands WHERE id=$1', [id]);
  if (!rowCount) return { ok: false };
  await unlinkDemandFromPayments(id); // הכסף לא נעלם — הופך לזיכוי כללי
  return { ok: true };
}
async function unlinkDemandFromPayments(demandId) {
  const { rows } = await pool.query('SELECT id, demand_ids FROM payments WHERE $1 = ANY(demand_ids)', [demandId]);
  for (const r of rows) {
    const updated = (r.demand_ids || []).filter(x => x !== demandId);
    await pool.query('UPDATE payments SET demand_ids=$2 WHERE id=$1', [r.id, updated]);
  }
}

// ══════════════════════════════════════════════════════════════
// תשלומים
// ══════════════════════════════════════════════════════════════
async function addPayment(data) {
  const rawStudentIds = data.studentIds || [];
  if (!rawStudentIds.length) return { ok: false, err: 'חובה לשייך לפחות תלמיד אחד' };

  const amounts = {};
  rawStudentIds.forEach(sid => {
    const a = parseFloat((data.amounts || {})[sid]) || 0;
    if (a > 0) amounts[sid] = a;
  });
  if (!Object.keys(amounts).length) return { ok: false, err: 'חובה להזין סכום לפחות לתלמיד אחד' };
  const studentIds = Object.keys(amounts);
  const total = Math.round(Object.values(amounts).reduce((s, v) => s + v, 0) * 100) / 100;
  const incomingDate = data.date ? new Date(data.date) : new Date();
  const incomingDateStr = da.fmtD(incomingDate);

  const existing = await da.getAllPayments();
  const dup = existing.some(p =>
    Math.abs(p.total - total) < 0.01 &&
    p.date === incomingDateStr &&
    [...p.studentIds].sort().join(',') === [...studentIds].sort().join(',') &&
    [...p.demandIds].sort().join(',') === [...(data.demandIds || [])].sort().join(',')
  );
  if (dup) return { ok: false, err: 'תשלום זהה כבר קיים (אותו סכום, תלמיד ותאריך)' };

  const id = logic.uid('P');
  await pool.query(
    `INSERT INTO payments (id, date, payer, student_ids, demand_ids, total, amounts, method, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, incomingDate, data.payer || '', studentIds, data.demandIds || [], total, JSON.stringify(amounts), data.method || 'מזומן', data.notes || '']
  );
  return { ok: true, id };
}

async function deletePayment(id) {
  const { rowCount } = await pool.query('DELETE FROM payments WHERE id=$1', [id]);
  return { ok: !!rowCount };
}

async function updatePayment(data) {
  const { rows } = await pool.query('SELECT student_ids FROM payments WHERE id=$1', [data.id]);
  if (!rows.length) return { ok: false, err: 'תשלום לא נמצא' };
  const studentIds = rows[0].student_ids || [];
  const amounts = {};
  studentIds.forEach(sid => {
    const a = parseFloat((data.amounts || {})[sid]) || 0;
    if (a > 0) amounts[sid] = a;
  });
  if (!Object.keys(amounts).length) return { ok: false, err: 'חובה סכום לפחות לתלמיד אחד' };
  const total = Math.round(Object.values(amounts).reduce((s, v) => s + v, 0) * 100) / 100;

  const sets = ['student_ids=$2', 'amounts=$3', 'total=$4'];
  const params = [data.id, Object.keys(amounts), JSON.stringify(amounts), total];
  if (data.payer !== undefined) { sets.push(`payer=$${params.length + 1}`); params.push(data.payer); }
  if (data.date) { sets.push(`date=$${params.length + 1}`); params.push(new Date(data.date)); }
  if (data.method !== undefined) { sets.push(`method=$${params.length + 1}`); params.push(data.method); }
  await pool.query(`UPDATE payments SET ${sets.join(', ')} WHERE id=$1`, params);
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// כרטסות
// ══════════════════════════════════════════════════════════════
async function getStudentLedger(studentId) {
  const [students, demands, payments, categories] = await Promise.all([
    da.getAllStudents(), da.getAllDemands(), da.getAllPayments(), da.getAllCategories()
  ]);
  const st = students.find(s => s.id === studentId);
  if (!st) return null;

  const siblings = students.filter(s => s.id !== studentId && logic.familyGroupIds(studentId, students).includes(s.id));

  const ledger = demands.filter(d => d.studentIds.includes(studentId)).map(d => {
    const catNames = d.categoryIds.map(cid => (categories.find(c => c.id === cid) || {}).name).filter(Boolean);
    const paid = logic.paidOnDemand(studentId, d.id, payments);
    const balance = d.amount - paid;
    const relPays = payments.filter(p => p.demandIds.includes(d.id) && p.studentIds.includes(studentId));
    return {
      demandId: d.id, title: d.title, catNames, isFamily: !!d.isFamily, dueDate: d.dueDate,
      amount: d.amount, paid: Math.round(paid * 100) / 100, balance: Math.round(balance * 100) / 100,
      payments: relPays.map(p => {
        const a = p.amounts[studentId];
        const share = (a !== undefined) ? parseFloat(a) || 0 : p.total / Math.max(p.studentIds.length, 1);
        return { id: p.id, payer: p.payer, share: Math.round(share * 100) / 100, date: p.date, method: p.method, notes: p.notes, isShared: p.studentIds.length > 1 };
      })
    };
  });

  const genCredit = Math.round(logic.generalCredit(studentId, payments) * 100) / 100;
  const genPays = payments.filter(p => p.demandIds.length === 0 && p.studentIds.includes(studentId)).map(p => {
    const a = p.amounts[studentId];
    const share = (a !== undefined) ? parseFloat(a) || 0 : p.total / Math.max(p.studentIds.length, 1);
    return { id: p.id, payer: p.payer, share: Math.round(share * 100) / 100, date: p.date, method: p.method, notes: p.notes };
  });

  const totalDemanded = Math.round(ledger.reduce((s, r) => s + r.amount, 0));
  const totalPaid = Math.round(ledger.reduce((s, r) => s + r.paid, 0) + genCredit);
  const totalBalance = Math.max(0, Math.round(ledger.reduce((s, r) => s + Math.max(0, r.balance), 0) - genCredit));

  return { student: st, siblings, ledger, genPays, genCredit, totalDemanded, totalPaid, totalBalance };
}

async function getFamilyLedger(studentId) {
  const [students, demands, payments] = await Promise.all([da.getAllStudents(), da.getAllDemands(), da.getAllPayments()]);
  const st = students.find(s => s.id === studentId);
  if (!st) return null;

  const familyIds = logic.familyGroupIds(studentId, students);
  const familyMembers = familyIds.map(id => students.find(s => s.id === id)).filter(Boolean);
  const nameById = {};
  familyMembers.forEach(m => { nameById[m.id] = m.firstName + ' ' + m.lastName; });

  const members = [];
  for (const id of familyIds) {
    const l = await getStudentLedger(id);
    if (l) members.push(l);
  }

  const familyTotalDemanded = members.reduce((s, m) => s + m.totalDemanded, 0);
  const familyTotalPaid = members.reduce((s, m) => s + m.totalPaid, 0);
  // נטו ברמת המשפחה, לא סכום היתרות האישיות: תשלום שלא פוצל בדיוק בין אחים (למשל תשלום כללי אחד
  // שמכסה כמה ילדים) לא אמור להישאר "חוב" אצל מי מהם כל עוד המשפחה כולה שילמה את מה שנדרש ממנה
  const familyNet = Math.round((familyTotalDemanded - familyTotalPaid) * 100) / 100; // חיובי=חוב, שלילי=זכות
  const familyTotalBalance = Math.max(0, familyNet);

  const demandNumberMap = {}, paymentNumberMap = {};
  let demandCounter = 0, paymentCounter = 0;

  const demandRows = [];
  demands.forEach(d => {
    const relFamily = d.studentIds.filter(sid => familyIds.includes(sid));
    if (!relFamily.length) return;
    const numKey = (d.isFamily && d.familyGroupId) ? ('FAM:' + d.familyGroupId) : d.id;
    if (!demandNumberMap[numKey]) demandNumberMap[numKey] = ++demandCounter;
    let sharedNames, isSharedFlag;
    if (d.isFamily && d.familyGroupId) {
      const groupMembers = demands.filter(x => x.familyGroupId === d.familyGroupId && familyIds.includes(x.studentIds[0]));
      sharedNames = groupMembers.map(x => nameById[x.studentIds[0]]);
      isSharedFlag = groupMembers.length > 1;
    } else {
      sharedNames = relFamily.map(sid => nameById[sid]);
      isSharedFlag = relFamily.length > 1;
    }
    relFamily.forEach(sid => {
      const paid = logic.paidOnDemand(sid, d.id, payments);
      demandRows.push({
        type: 'demand', num: demandNumberMap[numKey], id: d.id, date: d.createdDate, sortDate: d.createdDate,
        childId: sid, childName: nameById[sid], title: d.title, isFamily: !!d.isFamily, amount: d.amount,
        paid: Math.round(paid * 100) / 100, balance: Math.round((d.amount - paid) * 100) / 100,
        isShared: isSharedFlag, sharedWith: sharedNames.filter(n => n !== nameById[sid])
      });
    });
  });

  const paymentRows = [];
  payments.forEach(p => {
    const relFamily = p.studentIds.filter(sid => familyIds.includes(sid));
    if (!relFamily.length) return;
    if (!paymentNumberMap[p.id]) paymentNumberMap[p.id] = ++paymentCounter;
    const sharedNames = relFamily.map(sid => nameById[sid]);
    relFamily.forEach(sid => {
      const a = p.amounts[sid];
      const share = (a !== undefined) ? parseFloat(a) || 0 : p.total / Math.max(p.studentIds.length, 1);
      paymentRows.push({
        type: 'payment', num: paymentNumberMap[p.id], id: p.id, date: p.date, sortDate: p.date,
        childId: sid, childName: nameById[sid], payer: p.payer, method: p.method,
        amount: Math.round(share * 100) / 100, totalAmount: p.total,
        isShared: relFamily.length > 1, sharedWith: sharedNames.filter(n => n !== nameById[sid])
      });
    });
  });

  function toSortKey(dmy) {
    if (!dmy) return '0000-00-00';
    const parts = dmy.split('/');
    return parts.length === 3 ? (parts[2] + '-' + parts[1] + '-' + parts[0]) : '0000-00-00';
  }
  const timeline = [...demandRows, ...paymentRows].sort((a, b) => {
    const ka = toSortKey(a.sortDate), kb = toSortKey(b.sortDate);
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });

  const parentsMap = {};
  familyMembers.forEach(m => {
    [[m.dadName, m.dadPhone], [m.momName, m.momPhone]].forEach(([nm, ph]) => {
      if (!ph || !String(ph).trim()) return;
      const key = String(ph).trim();
      if (!parentsMap[key]) parentsMap[key] = { name: nm || '', phone: key };
    });
  });

  return {
    members,
    familyMembers: familyMembers.map(m => ({ id: m.id, firstName: m.firstName, lastName: m.lastName, class: m.class })),
    familyTotalDemanded: Math.round(familyTotalDemanded),
    familyTotalPaid: Math.round(familyTotalPaid),
    familyTotalBalance: Math.round(familyTotalBalance),
    familyNet: Math.round(familyNet),
    timeline, parents: Object.values(parentsMap)
  };
}

// ══════════════════════════════════════════════════════════════
// דשבורד וייצוא
// ══════════════════════════════════════════════════════════════
async function getDashboard() {
  const [students, demands, payments, categories] = await Promise.all([
    da.getAllStudents(), da.getAllDemands(), da.getAllPayments(), da.getAllCategories()
  ]);
  const active = students.filter(s => s.active === 'כן');
  let totDemanded = 0, totPaid = 0;
  const demStats = demands.map(d => {
    const n = d.studentIds.length, dem = n * d.amount;
    const paid = d.studentIds.reduce((s, sid) => s + logic.paidOnDemand(sid, d.id, payments), 0);
    totDemanded += dem; totPaid += paid;
    return { ...d, numStudents: n, totalDemanded: Math.round(dem), totalPaid: Math.round(paid * 100) / 100 };
  });
  totPaid += payments.filter(p => p.demandIds.length === 0).reduce((s, p) => s + p.total, 0);

  const debtList = students.map(s => {
    const debt = logic.studentDebt(s.id, demands, payments);
    if (debt < 0.01) return null;
    const unpaid = demands.filter(d => d.studentIds.includes(s.id) && logic.paidOnDemand(s.id, d.id, payments) < d.amount - 0.01);
    return { ...s, debt: Math.round(debt * 100) / 100, unpaidDemands: unpaid.map(d => d.title) };
  }).filter(Boolean).sort((a, b) => b.debt - a.debt);

  return {
    totalStudents: active.length, totalDemanded: Math.round(totDemanded), totalPaid: Math.round(totPaid),
    totalBalance: Math.round(totDemanded - totPaid), recentDemands: demStats.slice(-5).reverse(),
    categories: categories.map(c => ({ ...c, count: c.studentIds.length })), debtList
  };
}

async function getDebtExport() {
  const [students, demands, payments] = await Promise.all([da.getAllStudents(), da.getAllDemands(), da.getAllPayments()]);
  return students.map(s => {
    const debt = logic.studentDebt(s.id, demands, payments);
    if (debt < 0.01) return null;
    const details = demands.filter(d => d.studentIds.includes(s.id)).map(d => {
      const paid = logic.paidOnDemand(s.id, d.id, payments);
      const bal = Math.max(0, d.amount - paid);
      return bal > 0.01 ? { title: d.title, amount: d.amount, paid: Math.round(paid * 100) / 100, balance: Math.round(bal * 100) / 100 } : null;
    }).filter(Boolean);
    return { ...s, totalDebt: Math.round(debt * 100) / 100, details };
  }).filter(Boolean).sort((a, b) => b.totalDebt - a.totalDebt);
}

// ══════════════════════════════════════════════════════════════
// תשלומים ממתינים לשיוך
// ══════════════════════════════════════════════════════════════
async function getPendingPayments() { return da.getAllPending(); }

async function importPendingFromPaste(rawText) {
  const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0, skippedReasons = [];
  const validMethods = ['מזומן', 'העברה בנקאית', 'אפליקציה', 'שיק', 'אשראי', 'אחר'];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let cells = line.includes('\t') ? line.split('\t') : line.split(',');
    cells = cells.map(c => (c || '').trim());
    if (cells.length < 2) { skipped++; skippedReasons.push(`שורה ${idx + 1}: פחות מ-2 עמודות`); continue; }
    const dateRaw = cells[0], payerRaw = cells[1], amountRaw = cells[2];
    let methodRaw = cells[3] || '', notesRaw = cells[4] || '';
    if (methodRaw && validMethods.indexOf(methodRaw) === -1) {
      notesRaw = methodRaw + (notesRaw ? ' ' + notesRaw : '');
      methodRaw = '';
    }
    const amount = parseFloat(String(amountRaw || '').replace(/[^\d.-]/g, ''));
    if (!amount || amount <= 0) { skipped++; skippedReasons.push(`שורה ${idx + 1}: ${payerRaw || 'ללא שם'} — סכום לא תקין`); continue; }
    let dateVal;
    try { dateVal = dateRaw ? new Date(dateRaw) : new Date(); if (isNaN(dateVal.getTime())) dateVal = new Date(); }
    catch (e) { dateVal = new Date(); }

    await pool.query('INSERT INTO pending_payments (id, date, payer, amount, method, notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [logic.uid('N'), dateVal, payerRaw || '', amount, methodRaw || '', notesRaw || '']);
    added++;
  }
  return { ok: true, added, skipped, skippedReasons: skippedReasons.slice(0, 20) };
}

async function assignPendingPayment(pendingId, assignment) {
  const { rows } = await pool.query('SELECT * FROM pending_payments WHERE id=$1', [pendingId]);
  if (!rows.length) return { ok: false, err: 'שורה לא נמצאה' };
  const pendingRow = rows[0];

  const studentIds = assignment.studentIds || [];
  if (!studentIds.length) return { ok: false, err: 'חובה לבחור תלמיד אחד לפחות' };
  const amounts = {};
  studentIds.forEach(sid => { const a = parseFloat((assignment.amounts || {})[sid]) || 0; if (a > 0) amounts[sid] = a; });
  if (!Object.keys(amounts).length) return { ok: false, err: 'חובה להזין סכום' };
  const total = Math.round(Object.values(amounts).reduce((s, v) => s + v, 0) * 100) / 100;

  const id = logic.uid('P');
  await pool.query(
    `INSERT INTO payments (id, date, payer, student_ids, demand_ids, total, amounts, method, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, pendingRow.date, pendingRow.payer || assignment.payer || '', studentIds, assignment.demandIds || [],
     total, JSON.stringify(amounts), assignment.method || pendingRow.method || 'לא צויין', pendingRow.notes || '']
  );
  await pool.query('DELETE FROM pending_payments WHERE id=$1', [pendingId]);
  return { ok: true, id };
}

async function deletePendingPayment(pendingId) {
  const { rowCount } = await pool.query('DELETE FROM pending_payments WHERE id=$1', [pendingId]);
  return { ok: !!rowCount };
}

module.exports = {
  pingTest, getAllData,
  addStudent, updateStudent, deleteStudent, importStudentsFromPaste, backfillFamilyParentInfo,
  addCategory, updateCategory, deleteCategory,
  addDemand, updateDemand, removeStudentFromDemand, splitStudentFromDemand, addDemandVaried, deleteDemand,
  addPayment, deletePayment, updatePayment,
  getStudentLedger, getFamilyLedger, getDashboard, getDebtExport,
  getPendingPayments, importPendingFromPaste, assignPendingPayment, deletePendingPayment
};
