-- מערכת גיוס לערב שותפות — בית ספר חב"ד עפולה
-- אין מסך כניסה לשגריר רגיל: בוחרים "מי אני" מרשימת השגרירים, וזו הזהות שנשלחת בכל בקשה.
-- רק למנהל יש קוד גישה (pin_hash).

CREATE TABLE IF NOT EXISTS ambassadors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_campaign_manager BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE, -- "מנהל ראשי": לא מופיע ברשימת "מי אתה?", נכנסים אליו רק דרך קוד ייעודי
  pin_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- הגדרות קמפיין גלובליות — שורה יחידה, נערכת רק ע"י מנהל קמפיין
CREATE TABLE IF NOT EXISTS campaign_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  rsvp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  seating_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  login_mode TEXT NOT NULL DEFAULT 'none', -- 'none' | 'shared' | 'per_user'
  shared_login_pin_hash TEXT,
  event_name TEXT NOT NULL DEFAULT 'ערב שותפות',
  event_tagline TEXT NOT NULL DEFAULT 'הזמן שלנו להתאחד, לצמוח ולפרוץ קדימה',
  event_date_text TEXT NOT NULL DEFAULT 'יום שלישי · כ"ו אלול · 8.9 · בשעה 20:30',
  event_datetime TIMESTAMPTZ,
  event_location TEXT NOT NULL DEFAULT 'אולמי האושר, עפולה',
  org_name TEXT NOT NULL DEFAULT 'חב"ד עפולה',
  -- שלושת הטקסטים החופשיים בעמוד ההזמנה האישית (invite.html) — טקסט קבוע לגמרי, לא מורכב ממשתנים,
  -- כדי שמנהל קמפיין יוכל לנסח אותם בדיוק כרצונו כולל שורות חדשות (\n מוצג כ-<br> בתצוגה)
  invite_brand_text TEXT NOT NULL DEFAULT 'ערב שותפות · בית ספר חב"ד עפולה',
  invite_message_text TEXT NOT NULL DEFAULT 'הרינו מתכבדים להזמינך לערב שותפות מיוחד למען מוסדות חב"ד עפולה.
נשמח לראותך ולשתף אותך בהמשך הדרך.',
  invite_footer_text TEXT NOT NULL DEFAULT 'תודה שאתם חלק ממשפחת חב"ד עפולה 💛',
  -- משפטי עידוד — שורה לכל משפט, בשלוש קטגוריות נפרדות שכל אחת ניתנת לניהול כריבועים בממשק:
  -- כלליים (לשונית הסטטיסטיקה), שותפים (הודעה קופצת כשמעדכנים סטטוס), ומשתתפים (הודעה קופצת כשמצטרפים אנשי קשר)
  quotes_general TEXT NOT NULL DEFAULT 'כל שיחה נוספת שאתם עושים היא עוד לבנה בבניין המוסדות של חב"ד עפולה — תודה על המסירות!
אין דבר העומד בפני הרצון — וההתקדמות שלכם היא הוכחה חיה לכך. ממשיכים קדימה!
הרבי תמיד אמר שכל יהודי הוא שליח — ואתם ממש מגשימים את זה בכל שיחה.
אתם לא רק מגייסים לאירוע — אתם בונים קהילה. יישר כוח!
המוסדות של חב"ד עפולה גדלים בזכות אנשים כמוכם שמוכנים להשקיע מזמנם. תודה ענקית!
אתם השליחים של הרבי בשטח — וכל שיחה שלכם ממשיכה את השליחות שלו.',
  quotes_partners TEXT NOT NULL DEFAULT 'הערב הזה יקרה בזכותכם. כל "כן" שאתם מקבלים הוא ניצחון בשביל כל הקהילה.
כל איש קשר שהתקדם בזכותכם הוא סימן שהמאמץ שלכם עובד. תמשיכו כך!
בזכות שגרירים כמוכם, ערב השותפות הזה קורם עור וגידים מהר מהצפוי!
לא משנה כמה קשה השיחה — כל ניסיון הוא זריעה, והקציר יגיע.',
  quotes_participants TEXT NOT NULL DEFAULT 'מעשה קטן שלכם היום — שיחה אחת, טלפון אחד — יכול להביא שינוי גדול מחר.
גם שיחה שלא הצליחה היא חלק מהדרך — ממשיכים לחייג, לדבר, ולהאמין.
כל שם נוסף ברשימה שלכם הוא עוד אדם שמרגיש שייך. תודה שאתם לא מוותרים!',
  -- הפעלה/כיבוי לכל ריבוע/גרף בלשונית הסטטיסטיקה בנפרד — למנהל קמפיין
  stats_tiles_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stats_leader_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stats_chart_arriving_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stats_chart_registered_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stats_chart_effort_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stats_timeline_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stats_leaderboard_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- דוח מפורט בגוגל שיטס שמתעדכן אוטומטית: מזהה הגיליון שנוצר (פעם אחת, נשמר לשימוש חוזר),
  -- מייל לשיתוף (מנהל הקמפיין מזין), וזמן הסנכרון האחרון — לתצוגה בממשק
  google_sheet_id TEXT,
  google_sheet_share_email TEXT,
  google_sheet_last_synced_at TIMESTAMPTZ,
  logo_image BYTEA,
  logo_image_type TEXT,
  hero_image BYTEA,
  hero_image_type TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_settings_single_row CHECK (id = 1)
);
INSERT INTO campaign_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- "רשמי" = סיווג קבוע שמנהל הקמפיין קבע — מוצג ככפתור מהיר בכרטיס הפרטים. סיווג לא-רשמי
-- (שנוצר אוטומטית כשמישהו מקליד סיווג חופשי חדש) לא מופיע שם, רק בתוצאת הקלדה חופשית.
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_official BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  ambassador_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
  status TEXT,
  ambassador_candidate BOOLEAN NOT NULL DEFAULT FALSE,
  candidate_owner_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
  self_of_ambassador_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
  invite_token TEXT,
  seat_number TEXT,
  companion_seat_number TEXT,
  attending_with_companion BOOLEAN,
  invite_greeting_name TEXT,
  invite_companion_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- סיווג מרובה: כל איש קשר יכול לשאת כמה קטגוריות (טבלת קישור)
CREATE TABLE IF NOT EXISTS contact_categories (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, category_id)
);

CREATE TABLE IF NOT EXISTS status_history (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  changed_by INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- שיח פנימי לכל איש קשר: "מי מכיר את זה / איך יוצרים קשר" וכו'
CREATE TABLE IF NOT EXISTS contact_comments (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ambassador_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_comments_contact ON contact_comments(contact_id);

-- הימצאות מעברי גרסה — כל אלה חייבים לרוץ *לפני* יצירת אינדקסים/מיגרציית נתונים למטה,
-- כי CREATE TABLE IF NOT EXISTS הוא no-op על טבלה קיימת ולא מוסיף לה עמודות חדשות.
ALTER TABLE ambassadors ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ambassador_candidate BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS candidate_owner_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS self_of_ambassador_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS seat_number TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS companion_seat_number TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS attending_with_companion BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_greeting_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_companion_name TEXT;
ALTER TABLE ambassadors ADD COLUMN IF NOT EXISTS is_campaign_manager BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ambassadors ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS org_name TEXT NOT NULL DEFAULT 'חב"ד עפולה';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS invite_brand_text TEXT NOT NULL DEFAULT 'ערב שותפות · בית ספר חב"ד עפולה';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS invite_message_text TEXT NOT NULL DEFAULT 'הרינו מתכבדים להזמינך לערב שותפות מיוחד למען מוסדות חב"ד עפולה.
נשמח לראותך ולשתף אותך בהמשך הדרך.';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS invite_footer_text TEXT NOT NULL DEFAULT 'תודה שאתם חלק ממשפחת חב"ד עפולה 💛';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS quotes_general TEXT NOT NULL DEFAULT 'כל שיחה נוספת שאתם עושים היא עוד לבנה בבניין המוסדות של חב"ד עפולה — תודה על המסירות!
אין דבר העומד בפני הרצון — וההתקדמות שלכם היא הוכחה חיה לכך. ממשיכים קדימה!
הרבי תמיד אמר שכל יהודי הוא שליח — ואתם ממש מגשימים את זה בכל שיחה.
אתם לא רק מגייסים לאירוע — אתם בונים קהילה. יישר כוח!
המוסדות של חב"ד עפולה גדלים בזכות אנשים כמוכם שמוכנים להשקיע מזמנם. תודה ענקית!
אתם השליחים של הרבי בשטח — וכל שיחה שלכם ממשיכה את השליחות שלו.';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS quotes_partners TEXT NOT NULL DEFAULT 'הערב הזה יקרה בזכותכם. כל "כן" שאתם מקבלים הוא ניצחון בשביל כל הקהילה.
כל איש קשר שהתקדם בזכותכם הוא סימן שהמאמץ שלכם עובד. תמשיכו כך!
בזכות שגרירים כמוכם, ערב השותפות הזה קורם עור וגידים מהר מהצפוי!
לא משנה כמה קשה השיחה — כל ניסיון הוא זריעה, והקציר יגיע.';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS quotes_participants TEXT NOT NULL DEFAULT 'מעשה קטן שלכם היום — שיחה אחת, טלפון אחד — יכול להביא שינוי גדול מחר.
גם שיחה שלא הצליחה היא חלק מהדרך — ממשיכים לחייג, לדבר, ולהאמין.
כל שם נוסף ברשימה שלכם הוא עוד אדם שמרגיש שייך. תודה שאתם לא מוותרים!';
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_tiles_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_leader_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_chart_arriving_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_chart_registered_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_chart_effort_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_timeline_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS stats_leaderboard_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS google_sheet_id TEXT;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS google_sheet_share_email TEXT;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS google_sheet_last_synced_at TIMESTAMPTZ;

-- מעבר ממבנה קודם: עמודת motivational_quotes יחידה (שדרוג קצר-חיים) -> quotes_general, ומחיקתה
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'campaign_settings' AND column_name = 'motivational_quotes') THEN
    UPDATE campaign_settings SET quotes_general = motivational_quotes WHERE motivational_quotes IS NOT NULL;
    ALTER TABLE campaign_settings DROP COLUMN motivational_quotes;
  END IF;
END $$;

UPDATE campaign_settings SET event_datetime = '2026-09-08 20:30:00+03' WHERE event_datetime IS NULL;
DROP TABLE IF EXISTS sessions;

CREATE INDEX IF NOT EXISTS idx_contacts_ambassador ON contacts(ambassador_id);
CREATE INDEX IF NOT EXISTS idx_status_history_contact ON status_history(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_categories_contact ON contact_categories(contact_id);

-- לכל שגריר מותר לסמן "זה אני" על איש קשר אחד בלבד — אינדקס ייחודי חלקי (מתעלם מ-NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_self_ambassador ON contacts(self_of_ambassador_id) WHERE self_of_ambassador_id IS NOT NULL;

-- טוקן ההזמנה האישית חייב להיות ייחודי (מתעלם מ-NULL, לחלון הזמן עד שהמיגרציה משלימה אותם)
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_invite_token ON contacts(invite_token) WHERE invite_token IS NOT NULL;

-- מעבר מסיווג יחיד (category_id) לסיווגים מרובים (contact_categories)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'category_id') THEN
    INSERT INTO contact_categories (contact_id, category_id)
    SELECT id, category_id FROM contacts WHERE category_id IS NOT NULL
    ON CONFLICT DO NOTHING;
    ALTER TABLE contacts DROP COLUMN category_id;
  END IF;
END $$;
