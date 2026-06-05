// Turso Database Schema — Examforge
// All CREATE TABLE statements

export const SCHEMA_SQL = `
-- Users & profiles
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT UNIQUE,
  provider TEXT DEFAULT 'password',
  exa_rating INTEGER DEFAULT 800,
  streak INTEGER DEFAULT 0,
  highest_streak INTEGER DEFAULT 0,
  last_exam_date TEXT,
  role TEXT DEFAULT 'student',
  total_users INTEGER DEFAULT 0,
  fcm_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- User inbox (notifications)
CREATE TABLE IF NOT EXISTS user_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT,
  result_id TEXT,
  event_id TEXT,
  quiz_url TEXT,
  action_path TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- User schedule items
CREATE TABLE IF NOT EXISTS user_schedule (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT DEFAULT 'study',
  course TEXT,
  mock_id TEXT,
  event_id TEXT,
  quiz_url TEXT,
  time_limit INTEGER,
  due_date TEXT,
  due_time TEXT,
  message TEXT,
  dismissed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Recent results (embedded in user profile, but also stored here)
CREATE TABLE IF NOT EXISTS user_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quiz_id TEXT,
  course TEXT,
  score REAL DEFAULT 0,
  total REAL DEFAULT 100,
  grade TEXT DEFAULT 'F',
  correct INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  time_taken REAL DEFAULT 0,
  exa_change INTEGER DEFAULT 0,
  is_retake INTEGER DEFAULT 0,
  is_mock INTEGER DEFAULT 0,
  corrections TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Username mapping
CREATE TABLE IF NOT EXISTS usernames (
  username TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL
);

-- Courses
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  level TEXT DEFAULT '',
  total_time_limit INTEGER DEFAULT 0,
  is_strict INTEGER DEFAULT 0,
  is_mock INTEGER DEFAULT 0,
  is_correction INTEGER DEFAULT 0,
  topic_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Topics (within courses)
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  time_limit INTEGER DEFAULT 0,
  is_strict INTEGER DEFAULT 0,
  is_mock INTEGER DEFAULT 0,
  is_correction INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Questions (within topics)
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  question TEXT NOT NULL,
  option_a TEXT NOT NULL DEFAULT '',
  option_b TEXT NOT NULL DEFAULT '',
  option_c TEXT NOT NULL DEFAULT '',
  option_d TEXT NOT NULL DEFAULT '',
  correct_index INTEGER NOT NULL DEFAULT 0,
  explanation TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);

-- Daily quizzes
CREATE TABLE IF NOT EXISTS daily_quizzes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  time_limit INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Daily quiz questions
CREATE TABLE IF NOT EXISTS daily_quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id TEXT NOT NULL,
  question TEXT NOT NULL,
  option_a TEXT NOT NULL DEFAULT '',
  option_b TEXT NOT NULL DEFAULT '',
  option_c TEXT NOT NULL DEFAULT '',
  option_d TEXT NOT NULL DEFAULT '',
  correct_index INTEGER NOT NULL DEFAULT 0,
  explanation TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);

-- Daily quiz attempts per user
CREATE TABLE IF NOT EXISTS daily_quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score REAL DEFAULT 0,
  correct INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  time_taken REAL DEFAULT 0,
  answers TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Daily advice
CREATE TABLE IF NOT EXISTS daily_advices (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT '',
  content TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Subscription events
CREATE TABLE IF NOT EXISTS subscription_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  available_subjects TEXT DEFAULT '[]',
  max_subjects INTEGER DEFAULT 0,
  results_released INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Event registrations
CREATE TABLE IF NOT EXISTS event_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  subjects TEXT DEFAULT '[]',
  score REAL DEFAULT 0,
  correct INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  time_taken REAL DEFAULT 0,
  submitted_at TEXT
);

-- Event registration keys
CREATE TABLE IF NOT EXISTS event_keys (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT
);

-- Mock exams
CREATE TABLE IF NOT EXISTS mock_exams (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT DEFAULT '',
  time_limit INTEGER DEFAULT 0,
  questions TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Mock exam attempts
CREATE TABLE IF NOT EXISTS mock_exam_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mock_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  score REAL DEFAULT 0,
  correct INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  time_taken REAL DEFAULT 0,
  answers TEXT DEFAULT '[]',
  browser_agent TEXT,
  platform TEXT,
  screen_resolution TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Broadcast notifications (global)
CREATE TABLE IF NOT EXISTS broadcast_notifications (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT 'broadcast',
  title TEXT NOT NULL,
  message TEXT DEFAULT '',
  quiz_url TEXT,
  brand_color TEXT DEFAULT '#fe6961',
  brand_icon TEXT DEFAULT 'notifications',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Broadcast schedules (global)
CREATE TABLE IF NOT EXISTS broadcast_schedules (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT 'mock_exam',
  title TEXT NOT NULL,
  course TEXT DEFAULT '',
  mock_id TEXT,
  event_id TEXT,
  quiz_url TEXT,
  time_limit INTEGER,
  due_date TEXT,
  due_time TEXT,
  message TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Admin panel state
CREATE TABLE IF NOT EXISTS admin_panel (
  id TEXT PRIMARY KEY DEFAULT 'data',
  courses TEXT DEFAULT '[]',
  daily_quizzes TEXT DEFAULT '[]',
  daily_advices TEXT DEFAULT '[]',
  subscription_events TEXT DEFAULT '[]',
  total_student_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Counters
CREATE TABLE IF NOT EXISTS counters (
  id TEXT PRIMARY KEY,
  value INTEGER DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_results_user ON user_results(user_id);
CREATE INDEX IF NOT EXISTS idx_user_inbox_user ON user_inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_user_schedule_user ON user_schedule(user_id);
CREATE INDEX IF NOT EXISTS idx_topics_course ON topics(course_id);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON event_registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_mock_attempts_mock ON mock_exam_attempts(mock_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON daily_quiz_attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_event_keys_event ON event_keys(event_id);
`;

// Run all table creation
export async function initSchema(db) {
  try {
    // Execute all CREATE statements as a single SQL string
    const allSql = SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.toUpperCase().startsWith('CREATE'))
      .join(';\n') + ';';
    
    await db.execute(allSql);
    console.log('[Schema] All tables created successfully');
  } catch (e) {
    console.warn('[Schema] Full schema creation failed:', e.message);
    // Fallback: create tables one by one
    const statements = SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.toUpperCase().startsWith('CREATE'));
    
    for (const sql of statements) {
      try {
        await db.execute(sql + ';');
      } catch (e2) {
        console.warn('[Schema] Error creating table:', e2.message);
      }
    }
  }
  console.log('[Schema] Schema initialization complete');
}
