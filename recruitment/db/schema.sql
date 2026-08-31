-- מערכת גיוס לערב שותפות — בית ספר חב"ד עפולה
-- אין מסך כניסה לשגריר רגיל: בוחרים "מי אני" מרשימת השגרירים, וזו הזהות שנשלחת בכל בקשה.
-- רק למנהל יש קוד גישה (pin_hash).

CREATE TABLE IF NOT EXISTS ambassadors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  pin_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
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
