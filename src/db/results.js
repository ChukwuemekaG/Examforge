import { execOne, exec, execute, trackRead } from './client.js';

export async function getResult(resultId, userId) {
  trackRead('user_results/' + resultId);
  return execOne('SELECT * FROM user_results WHERE id = ? AND user_id = ?', { 1: resultId, 2: userId });
}

export async function saveUserResult(userId, result) {
  const id = result.id || 'res_' + Date.now().toString(36);
  await execute(
    `INSERT INTO user_results (id, user_id, quiz_id, course, score, total, grade, correct, total_questions, time_taken, exa_change, is_retake, is_mock, corrections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: userId, 3: result.quizId || '', 4: result.course || '', 5: result.score || 0, 6: result.total || 100, 7: result.grade || 'F', 8: result.correct || 0, 9: result.totalQuestions || 0, 10: result.timeTaken || 0, 11: result.exaChange || 0, 12: result.isRetake ? 1 : 0, 13: result.isMock ? 1 : 0, 14: JSON.stringify(result.corrections || []) }
  );
  return id;
}
