import { execOne, exec, execute, trackRead } from './client.js';

export async function getAllQuizzes() {
  trackRead('daily_quizzes/all');
  return exec('SELECT * FROM daily_quizzes ORDER BY created_at DESC');
}

export async function getQuiz(id) {
  trackRead('daily_quizzes/' + id);
  return execOne('SELECT * FROM daily_quizzes WHERE id = ?', [id]);
}

export async function createQuiz(quiz) {
  const id = quiz.id || 'dq_' + Date.now().toString(36);
  await execute(
    `INSERT INTO daily_quizzes (id, title, time_limit, max_attempts)
     VALUES (?, ?, ?, ?)`,
    [id, quiz.title, quiz.timeLimit || 0, quiz.maxAttempts || 1]
  );
  return id;
}

export async function deleteQuiz(id) {
  await execute('DELETE FROM daily_quiz_questions WHERE quiz_id = ?', [id]);
  await execute('DELETE FROM daily_quiz_attempts WHERE quiz_id = ?', [id]);
  return execute('DELETE FROM daily_quizzes WHERE id = ?', [id]);
}

// Quiz questions
export async function getQuizQuestions(quizId) {
  trackRead('daily_quiz_questions/' + quizId);
  return exec('SELECT * FROM daily_quiz_questions WHERE quiz_id = ? ORDER BY sort_order ASC', [quizId]);
}

export async function setQuizQuestions(quizId, questions) {
  await execute('DELETE FROM daily_quiz_questions WHERE quiz_id = ?', [quizId]);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    await execute(
      `INSERT INTO daily_quiz_questions (quiz_id, question, option_a, option_b, option_c, option_d, correct_index, explanation, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quizId, q.question, q.options?.[0] || q.optionA || '', q.options?.[1] || q.optionB || '', q.options?.[2] || q.optionC || '', q.options?.[3] || q.optionD || '', q.correctIndex, q.explanation || '', i]
    );
  }
}

// Quiz attempts
export async function getQuizAttempts(quizId) {
  trackRead('daily_quiz_attempts/' + quizId);
  return exec('SELECT * FROM daily_quiz_attempts WHERE quiz_id = ? ORDER BY created_at DESC', [quizId]);
}

export async function saveQuizAttempt(quizId, userId, attempt) {
  return execute(
    `INSERT INTO daily_quiz_attempts (quiz_id, user_id, score, correct, total, time_taken, answers)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [quizId, userId, attempt.score || 0, attempt.correct || 0, attempt.total || 0, attempt.timeTaken || 0, JSON.stringify(attempt.answers || [])]
  );
}

export async function hasUserTakenQuiz(quizId, userId) {
  const row = await execOne('SELECT COUNT(*) as count FROM daily_quiz_attempts WHERE quiz_id = ? AND user_id = ?', [quizId, userId]);
  return (row?.count || 0) > 0;
}
