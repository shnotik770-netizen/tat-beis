-- מערכת גיוס לערב שותפות — בית ספר חב"ד עפולה
-- אין מסך כניסה: בוחרים "מי אני" מרשימת השגרירים, וזו הזהות שנשלחת בכל בקשה.

CREATE TABLE IF NOT EXISTS ambassadors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
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
  created_by INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_contacts_ambassador ON contacts(ambassador_id);
CREATE INDEX IF NOT EXISTS idx_status_history_contact ON status_history(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_categories_contact ON contact_categories(contact_id);

-- הימצאות מעברי גרסה: הסרת מסך הכניסה (PIN) וטבלת ה-sessions ממערכות קיימות
ALTER TABLE ambassadors DROP COLUMN IF EXISTS pin_hash;
DROP TABLE IF EXISTS sessions;

-- הימצאות מעברי גרסה: הוספת "מועמד/ת לשגרירות" למערכות קיימות (CREATE TABLE IF NOT EXISTS לא מוסיף עמודות לטבלה קיימת)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ambassador_candidate BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS candidate_owner_id INTEGER REFERENCES ambassadors(id) ON DELETE SET NULL;

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
