// תמונת תצוגה מקדימה (og:image) מותאמת אישית לכל מוזמן — נוצרת בזמן אמת בצד השרת
// (לא תמונת "Save the Date" אחידה) כדי שקישור ההזמנה יראה "לכבוד [שם]" ממש בתוך התצוגה
// המקדימה בוואטסאפ/RCS וכו', כמו הכרטיס עצמו בעמוד ההזמנה.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const FONT_DIR = path.join(__dirname, 'fonts');
// Noto Sans (לטיני) נטען כגיבוי לתווים שחסרים בפונט העברי (למשל נקודה אמצעית "·" ומירכאות ASCII) —
// resvg נופל אליו אוטומטית לפי כיסוי הגליפים בכל תו, בלי לשנות את font-family ב-SVG עצמו
const FONT_FILES = [
  'NotoSansHebrew-Regular.ttf', 'NotoSansHebrew-Bold.ttf', 'NotoSansHebrew-Black.ttf',
  'NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Black.ttf'
].map((f) => path.join(FONT_DIR, f));
const HANDSHAKE_SVG_INNER = fs
  .readFileSync(path.join(__dirname, 'assets', 'handshake.svg'), 'utf8')
  .replace(/^<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '');

const WIDTH = 1000;
const HEIGHT = 1000;

function escXml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// כדי ששם ארוך לא ייצא מגבולות הכרטיס — מקטינים את הגופן בהדרגה לפי אורך הטקסט
function nameFontSize(text) {
  const len = String(text || '').length;
  if (len <= 14) return 52;
  if (len <= 22) return 42;
  if (len <= 30) return 34;
  return 28;
}

function buildSvg({ brandText, guestName, companionName, tagline, dateText, location }) {
  const guestSize = nameFontSize(guestName);
  const companionSize = companionName ? nameFontSize('ו' + companionName) : 0;

  // גובה התוכן הכולל (כרטיס לבן + רווח + תיבה כחולה) כדי למרכז אנכית בתוך הקנבס, כמו בעמוד עצמו
  const cardHeight = 90 + 100 + 34 + 56 + 50 + guestSize + 16 + (companionName ? companionSize + 14 : 0) + 40;
  const gap = 28;
  const boxHeight = 190;
  const totalHeight = cardHeight + gap + boxHeight;
  const top = Math.max(40, Math.round((HEIGHT - totalHeight) / 2));

  const cardY = top;
  let y = cardY + 90;
  const crestY = y;
  y += 100 + 34;
  const brandY = y;
  y += 56;
  const titleY = y;
  y += 50;
  const toY = y;
  y += guestSize;
  const guestY = y;
  let companionY = 0;
  if (companionName) {
    y += companionSize + 14;
    companionY = y;
  }

  const boxY = cardY + cardHeight + gap;
  const boxTaglineY = boxY + 56;
  const boxDateY = boxY + 106;
  const boxLocationY = boxY + 144;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="0%" r="90%">
      <stop offset="0%" stop-color="#fff8e6"/>
      <stop offset="60%" stop-color="#fdf8ee"/>
    </radialGradient>
    <linearGradient id="navy" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>

  <rect x="76" y="${cardY + 6}" width="848" height="${cardHeight}" rx="28" fill="#000000" fill-opacity="0.06"/>
  <rect x="70" y="${cardY}" width="860" height="${cardHeight}" rx="28" fill="#ffffff"/>

  <svg x="450" y="${crestY}" width="100" height="100" viewBox="0 0 36 36">${HANDSHAKE_SVG_INNER}</svg>

  <text x="500" y="${brandY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="800" font-size="24" letter-spacing="1" fill="#c8952e">${escXml(brandText)}</text>
  <text x="500" y="${titleY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="900" font-size="46" fill="#1e293b">הזמנה אישית</text>
  <text x="500" y="${toY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="400" font-size="22" fill="#7a6f57">לכבוד</text>
  <text x="500" y="${guestY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="900" font-size="${guestSize}" fill="#1e293b">${escXml(guestName)}</text>
  ${companionName ? `<text x="500" y="${companionY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="900" font-size="${companionSize}" fill="#1e293b">${escXml('ו' + companionName)}</text>` : ''}

  <rect x="70" y="${boxY}" width="860" height="${boxHeight}" rx="24" fill="url(#navy)"/>
  <text x="500" y="${boxTaglineY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="800" font-size="26" fill="#f2c869">${escXml(tagline)}</text>
  <text x="500" y="${boxDateY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="700" font-size="24" fill="#ffffff">${escXml(dateText)}</text>
  <text x="500" y="${boxLocationY}" text-anchor="middle" font-family="Noto Sans Hebrew" font-weight="400" font-size="22" fill="#cbd5e1">${escXml(location)}</text>
</svg>`;
}

function renderInviteCardPng(data) {
  const svg = buildSvg(data);
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: 'Noto Sans Hebrew'
    },
    background: 'white'
  });
  return resvg.render().asPng();
}

module.exports = { renderInviteCardPng, WIDTH, HEIGHT };
