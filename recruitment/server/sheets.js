// סנכרון דוח מפורט לגיליון גוגל שיטס משותף, שמתעדכן אוטומטית ברענון מלא כל כמה דקות.
// דורש חשבון שירות (service account) בגוגל קלאוד עם Sheets API + Drive API מופעלים,
// ומשתני הסביבה GOOGLE_SERVICE_ACCOUNT_EMAIL ו-GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY מוגדרים
// ב-Railway (ראו README). בלי זה — הפיצ'ר פשוט לא זמין, שאר המערכת ממשיכה לעבוד כרגיל.
const { google } = require('googleapis');
const { pool } = require('./db');
const { REPORT_COLUMNS, fetchReportRows } = require('./report');

const SHEET_TAB_NAME = 'אנשי קשר';

function credentialsConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(email, null, key, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ]);
}

// יוצר את הגיליון פעם אחת בלבד (המזהה נשמר ב-DB ומשמש בכל הסנכרונים הבאים).
// אם הוגדר מייל לשיתוף — משתפים אותו כעורך מיד עם היצירה.
async function ensureSheetId(auth, shareEmail) {
  const { rows } = await pool.query('SELECT google_sheet_id FROM campaign_settings WHERE id = 1');
  const existing = rows[0] && rows[0].google_sheet_id;
  if (existing) return existing;

  const sheets = google.sheets({ version: 'v4', auth });
  const { rows: orgRows } = await pool.query('SELECT org_name FROM campaign_settings WHERE id = 1');
  const orgName = (orgRows[0] && orgRows[0].org_name) || 'מערכת גיוס';
  const create = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `דוח אנשי קשר מפורט — ${orgName}`, locale: 'he_IL' },
      sheets: [{ properties: { title: SHEET_TAB_NAME, rightToLeft: true } }]
    }
  });
  const spreadsheetId = create.data.spreadsheetId;
  await pool.query('UPDATE campaign_settings SET google_sheet_id = $1, updated_at = now() WHERE id = 1', [spreadsheetId]);

  if (shareEmail) await shareSheet(auth, spreadsheetId, shareEmail);
  return spreadsheetId;
}

// שיתוף (או שיתוף חוזר) של הגיליון עם המייל שמנהל הקמפיין הזין — שגיאה כאן (למשל שיתוף כפול)
// לא אמורה להפיל את הסנכרון, רק להירשם ביומן
async function shareSheet(auth, spreadsheetId, shareEmail) {
  try {
    const drive = google.drive({ version: 'v3', auth });
    await drive.permissions.create({
      fileId: spreadsheetId,
      sendNotificationEmail: false,
      requestBody: { type: 'user', role: 'writer', emailAddress: shareEmail }
    });
  } catch (e) {
    console.error('שיתוף גיליון גוגל שיטס נכשל:', e.message);
  }
}

// מבצע רענון מלא של הדוח בגיליון. forceShare=true (מהכפתור הידני) מנסה לשתף שוב עם המייל
// הנוכחי בכל פעם (לטובת מייל ששונה או הזמנה שלא התקבלה); הסנכרון האוטומטי לא עושה זאת בכל סבב.
async function syncNow({ forceShare = false } = {}) {
  if (!credentialsConfigured()) throw new Error('לא הוגדרו פרטי גישה לגוגל שיטס בשרת');
  const { rows } = await pool.query('SELECT google_sheet_share_email, google_sheet_id FROM campaign_settings WHERE id = 1');
  const shareEmail = rows[0] && rows[0].google_sheet_share_email;
  const auth = getAuth();
  const hadSheetAlready = !!(rows[0] && rows[0].google_sheet_id);
  const spreadsheetId = await ensureSheetId(auth, shareEmail);
  if (forceShare && hadSheetAlready && shareEmail) await shareSheet(auth, spreadsheetId, shareEmail);

  const reportRows = await fetchReportRows(pool);
  const header = REPORT_COLUMNS.map(c => c.header);
  const values = [header, ...reportRows.map(row => REPORT_COLUMNS.map(col => row[col.key]))];

  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: SHEET_TAB_NAME });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  await pool.query('UPDATE campaign_settings SET google_sheet_last_synced_at = now() WHERE id = 1');
  return spreadsheetId;
}

let intervalHandle = null;
function startAutoSync(intervalMinutes) {
  if (!credentialsConfigured()) return;
  if (intervalHandle) clearInterval(intervalHandle);
  const ms = Math.max(1, intervalMinutes || 5) * 60 * 1000;
  intervalHandle = setInterval(() => {
    syncNow().catch(e => console.error('סנכרון גוגל שיטס אוטומטי נכשל:', e.message));
  }, ms);
}

module.exports = { credentialsConfigured, syncNow, startAutoSync };
