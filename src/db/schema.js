// Turso Database Schema — Examforge
// Hardcoded CREATE TABLE statements — no parsing needed

export async function initSchema(db) {
  // Check if tables already exist (skip schema init on subsequent loads)
  try {
    const result = await db.exec("SELECT COUNT(*) as cnt FROM users");
    // Continue to table creation even if users table exists; errors for existing tables are caught later
  } catch (e) {
    // Table doesn't exist, proceed with creation
    console.log('[Schema] Tables not found, creating...');
  }

  // Essential tables with hardcoded SQL — no parsing needed
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      username TEXT,
      provider TEXT DEFAULT 'password',
      exa_rating INTEGER DEFAULT 800,
      streak INTEGER DEFAULT 0,
      highest_streak INTEGER DEFAULT 0,
      last_exam_date TEXT,
      role TEXT DEFAULT 'student',
      total_users INTEGER DEFAULT 0,
      fcm_token TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS broadcast_notifications (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT 'broadcast',
      title TEXT NOT NULL,
      message TEXT DEFAULT '',
      quiz_url TEXT,
      brand_color TEXT DEFAULT '#fe6961',
      brand_icon TEXT DEFAULT 'notifications',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS broadcast_schedules (
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS counters (
      id TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS user_inbox (
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS user_schedule (
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS user_results (
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      available_subjects TEXT DEFAULT '[]',
      max_subjects INTEGER DEFAULT 0,
      results_released INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS event_registrations (
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
    )`,
    `CREATE TABLE IF NOT EXISTS event_keys (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      used_by TEXT,
      used_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS mock_exams (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      title TEXT DEFAULT '',
      time_limit INTEGER DEFAULT 0,
      questions TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS mock_exam_attempts (
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      level TEXT DEFAULT '',
      total_time_limit INTEGER DEFAULT 0,
      is_strict INTEGER DEFAULT 0,
      is_mock INTEGER DEFAULT 0,
      is_correction INTEGER DEFAULT 0,
      topic_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      title TEXT NOT NULL,
      time_limit INTEGER DEFAULT 0,
      is_strict INTEGER DEFAULT 0,
      is_mock INTEGER DEFAULT 0,
      is_correction INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      question TEXT NOT NULL,
      option_a TEXT DEFAULT '',
      option_b TEXT DEFAULT '',
      option_c TEXT DEFAULT '',
      option_d TEXT DEFAULT '',
      correct_index INTEGER NOT NULL DEFAULT 0,
      explanation TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS daily_quizzes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      time_limit INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daily_quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id TEXT NOT NULL,
      question TEXT NOT NULL,
      option_a TEXT DEFAULT '',
      option_b TEXT DEFAULT '',
      option_c TEXT DEFAULT '',
      option_d TEXT DEFAULT '',
      correct_index INTEGER NOT NULL DEFAULT 0,
      explanation TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS daily_quiz_broadcasts (
      broadcast_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      quiz_url TEXT,
      message TEXT,
      due_date TEXT,
      due_time TEXT,
      recipient_count INTEGER DEFAULT 0,
      sent_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daily_quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      score REAL DEFAULT 0,
      correct INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      time_taken REAL DEFAULT 0,
      answers TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daily_advices (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT DEFAULT '',
      content TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admin_panel (
      id TEXT PRIMARY KEY DEFAULT 'data',
      courses TEXT DEFAULT '[]',
      daily_quizzes TEXT DEFAULT '[]',
      daily_advices TEXT DEFAULT '[]',
      subscription_events TEXT DEFAULT '[]',
      total_student_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS usernames (
      username TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL
    )`
  ];

  // Create tables one by one with detailed logging
  let allOk = true;
  for (let i = 0; i < tables.length; i++) {
    const sql = tables[i];
    const name = sql.match(/TABLE (?:IF NOT EXISTS )?(\w+)/)?.[1] || 'unknown';
    try {
      await db.execute(sql);
      console.log('[Schema] Created:', name);
    } catch (e) {
      console.warn('[Schema] Failed:', name, '-', e.message.slice(0, 100));
      allOk = false;
    }
  }

  if (allOk) {
    console.log('[Schema] All ' + tables.length + ' tables created successfully');
  } else {
    console.log('[Schema] Some tables failed to create');
  }

  // Migration for topics table if id column is not TEXT
  console.log('[Schema] Starting migrations...');
  const info = await db.exec('PRAGMA table_info(topics)');
  const idCol = info.find(col => col.name === 'id');
  if (idCol && idCol.type.toUpperCase() !== 'TEXT') {
    console.log('[Schema] Migrating topics table to TEXT id');
    await db.execute('ALTER TABLE topics RENAME TO topics_old');
    await db.execute(`CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      title TEXT NOT NULL,
      time_limit INTEGER DEFAULT 0,
      is_strict INTEGER DEFAULT 0,
      is_mock INTEGER DEFAULT 0,
      is_correction INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.execute(`INSERT INTO topics (id, course_id, title, time_limit, is_strict, is_mock, is_correction, sort_order, created_at)
      SELECT id, course_id, title, time_limit, is_strict, is_mock, is_correction, sort_order, created_at FROM topics_old`);
    await db.execute('DROP TABLE topics_old');
    console.log('[Schema] Topics migration completed');
  }
  console.log('[Schema] Migrations finished');
}
