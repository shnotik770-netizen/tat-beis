-- מערכת ניהול תשלומים — סכמת PostgreSQL
-- מבנה לוגי זהה לגיליונות המקוריים ב-Google Sheets, אך עם טיפוסים נכונים (מערכים, JSONB, תאריכים)

CREATE TABLE IF NOT EXISTS students (
  id            TEXT PRIMARY KEY,
  last_name     TEXT NOT NULL DEFAULT '',
  first_name    TEXT NOT NULL DEFAULT '',
  class         TEXT NOT NULL DEFAULT '',
  institution   TEXT NOT NULL DEFAULT '',
  dad_name      TEXT NOT NULL DEFAULT '',
  dad_phone     TEXT NOT NULL DEFAULT '',
  mom_name      TEXT NOT NULL DEFAULT '',
  mom_phone     TEXT NOT NULL DEFAULT '',
  category_ids  TEXT[] NOT NULL DEFAULT '{}',
  active        TEXT NOT NULL DEFAULT 'כן',
  tz            TEXT NOT NULL DEFAULT '',
  birth_date    TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  student_ids   TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demands (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  amount          NUMERIC NOT NULL DEFAULT 0,
  created_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date        TIMESTAMPTZ,
  category_ids    TEXT[] NOT NULL DEFAULT '{}',
  student_ids     TEXT[] NOT NULL DEFAULT '{}',
  notes           TEXT NOT NULL DEFAULT '',
  is_family       BOOLEAN NOT NULL DEFAULT false,
  family_group_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  payer         TEXT NOT NULL DEFAULT '',
  student_ids   TEXT[] NOT NULL DEFAULT '{}',
  demand_ids    TEXT[] NOT NULL DEFAULT '{}',
  total         NUMERIC NOT NULL DEFAULT 0,
  amounts       JSONB NOT NULL DEFAULT '{}',
  method        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pending_payments (
  id            TEXT PRIMARY KEY,
  date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  payer         TEXT NOT NULL DEFAULT '',
  amount        NUMERIC NOT NULL DEFAULT 0,
  method        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_demands_student_ids ON demands USING GIN (student_ids);
CREATE INDEX IF NOT EXISTS idx_payments_student_ids ON payments USING GIN (student_ids);
CREATE INDEX IF NOT EXISTS idx_payments_demand_ids ON payments USING GIN (demand_ids);
CREATE INDEX IF NOT EXISTS idx_students_active ON students (active);
