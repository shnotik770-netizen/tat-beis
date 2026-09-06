const crypto = require('crypto');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateInviteToken() {
  return crypto.randomBytes(12).toString('hex');
}

// קוד קצר לקישור מקוצר (/i/<code>) — לא מחליף את invite_token (שנשאר כפי שהוא, כדי
// שקישורים ארוכים שכבר נשלחו ימשיכו לעבוד בדיוק כמו היום), רק דרך נוספת וקצרה יותר לשתף
// אותה הזמנה. בלי 0/O/1/I/L כדי למנוע בלבול ויזואלי בין תווים דומים.
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateShortCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  return code;
}

module.exports = { hashPin, verifyPin, generateInviteToken, generateShortCode };
