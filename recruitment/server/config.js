// כתובת השורש הציבורית המלאה של השירות — משמשת לבניית קישורים מוחלטים (תמונת תצוגה מקדימה
// אישית להזמנה, קישורי הזמנה בדוח) בלי לשכפל את אותה ברירת מחדל בכמה קבצים
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://recruitment-app-production-9b50.up.railway.app';

module.exports = { PUBLIC_BASE_URL };
