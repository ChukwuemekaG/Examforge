import { execOne, exec, execute, trackRead } from './client.js';

export async function getAllCourses() {
  trackRead('courses/all');
  return exec('SELECT * FROM courses ORDER BY title ASC');
}

export async function getCourse(id) {
  trackRead('courses/' + id);
  return execOne('SELECT * FROM courses WHERE id = ?', { 1: id });
}

export async function createCourse(course) {
  const id = course.id || 'course_' + Date.now().toString(36);
  await execute(
    `INSERT INTO courses (id, title, level, total_time_limit, is_strict, is_mock, is_correction)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: course.title, 3: course.level || '', 4: course.totalTimeLimit || 0, 5: course.isStrict ? 1 : 0, 6: course.isMock ? 1 : 0, 7: course.isCorrection ? 1 : 0 }
  );
  return id;
}

export async function updateCourse(id, fields) {
  const setClauses = [];
  const args = {};
  let idx = 1;
  if (fields.title !== undefined) { setClauses.push('title = ?'); args[idx++] = fields.title; }
  if (fields.level !== undefined) { setClauses.push('level = ?'); args[idx++] = fields.level; }
  if (fields.totalTimeLimit !== undefined) { setClauses.push('total_time_limit = ?'); args[idx++] = fields.totalTimeLimit; }
  if (fields.isStrict !== undefined) { setClauses.push('is_strict = ?'); args[idx++] = fields.isStrict ? 1 : 0; }
  if (fields.topicCount !== undefined) { setClauses.push('topic_count = ?'); args[idx++] = fields.topicCount; }
  args[idx++] = id;
  return execute(`UPDATE courses SET ${setClauses.join(', ')} WHERE id = ?`, args);
}

export async function deleteCourse(id) {
  return execute('DELETE FROM courses WHERE id = ?', { 1: id });
}

// Topics
export async function getTopics(courseId) {
  trackRead('topics/' + courseId);
  return exec('SELECT * FROM topics WHERE course_id = ? ORDER BY sort_order ASC', { 1: courseId });
}

export async function getTopic(id) {
  return execOne('SELECT * FROM topics WHERE id = ?', { 1: id });
}

export async function createTopic(topic) {
  const id = topic.id || 'topic_' + Date.now().toString(36);
  await execute(
    `INSERT INTO topics (id, course_id, title, time_limit, is_strict, is_mock, is_correction, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: topic.courseId, 3: topic.title, 4: topic.timeLimit || 0, 5: topic.isStrict ? 1 : 0, 6: topic.isMock ? 1 : 0, 7: topic.isCorrection ? 1 : 0, 8: topic.sortOrder || 0 }
  );
  return id;
}

export async function updateTopic(id, fields) {
  const setClauses = [];
  const args = {};
  let idx = 1;
  if (fields.title !== undefined) { setClauses.push('title = ?'); args[idx++] = fields.title; }
  if (fields.timeLimit !== undefined) { setClauses.push('time_limit = ?'); args[idx++] = fields.timeLimit; }
  args[idx++] = id;
  return execute(`UPDATE topics SET ${setClauses.join(', ')} WHERE id = ?`, args);
}

export async function deleteTopic(id) {
  return execute('DELETE FROM questions WHERE topic_id = ?', { 1: id })
    .then(() => execute('DELETE FROM topics WHERE id = ?', { 1: id }));
}

// Questions
export async function getQuestions(topicId) {
  trackRead('questions/' + topicId);
  return exec('SELECT * FROM questions WHERE topic_id = ? ORDER BY sort_order ASC', { 1: topicId });
}

export async function createQuestion(q) {
  return execute(
    `INSERT INTO questions (topic_id, course_id, question, option_a, option_b, option_c, option_d, correct_index, explanation, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: q.topicId, 2: q.courseId, 3: q.question, 4: q.optionA || '', 5: q.optionB || '', 6: q.optionC || '', 7: q.optionD || '', 8: q.correctIndex, 9: q.explanation || '', 10: q.sortOrder || 0 }
  );
}

export async function updateQuestion(id, q) {
  return execute(
    `UPDATE questions SET question = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_index = ?, explanation = ?
     WHERE id = ?`,
    { 1: q.question, 2: q.optionA || '', 3: q.optionB || '', 4: q.optionC || '', 5: q.optionD || '', 6: q.correctIndex, 7: q.explanation || '', 8: id }
  );
}

export async function deleteQuestion(id) {
  return execute('DELETE FROM questions WHERE id = ?', { 1: id });
}
