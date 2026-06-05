import { execOne, exec, execute, trackRead } from './client.js';

export async function getAllCourses() {
  trackRead('courses/all');
  return exec('SELECT * FROM courses ORDER BY title ASC');
}

export async function getCourse(id) {
  trackRead('courses/' + id);
  return execOne('SELECT * FROM courses WHERE id = ?', [id]);
}

export async function createCourse(course) {
  const id = course.id || 'course_' + Date.now().toString(36);
  await execute(
    `INSERT INTO courses (id, title, level, total_time_limit, is_strict, is_mock, is_correction)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, course.title, course.level || '', course.totalTimeLimit || 0, course.isStrict ? 1 : 0, course.isMock ? 1 : 0, course.isCorrection ? 1 : 0]
  );
  return id;
}

export async function updateCourse(id, fields) {
  const setClauses = [];
  const args = [];
  if (fields.title !== undefined) { setClauses.push('title = ?'); args.push(fields.title); }
  if (fields.level !== undefined) { setClauses.push('level = ?'); args.push(fields.level); }
  if (fields.totalTimeLimit !== undefined) { setClauses.push('total_time_limit = ?'); args.push(fields.totalTimeLimit); }
  if (fields.isStrict !== undefined) { setClauses.push('is_strict = ?'); args.push(fields.isStrict ? 1 : 0); }
  if (fields.topicCount !== undefined) { setClauses.push('topic_count = ?'); args.push(fields.topicCount); }
  args.push(id);
  return execute(`UPDATE courses SET ${setClauses.join(', ')} WHERE id = ?`, args);
}

export async function deleteCourse(id) {
  return execute('DELETE FROM courses WHERE id = ?', [id]);
}

// Topics
export async function getTopics(courseId) {
  trackRead('topics/' + courseId);
  return exec('SELECT * FROM topics WHERE course_id = ? ORDER BY sort_order ASC', [courseId]);
}

export async function getTopic(id) {
  return execOne('SELECT * FROM topics WHERE id = ?', [id]);
}

export async function createTopic(topic) {
  const id = topic.id || 'topic_' + Date.now().toString(36);
  await execute(
    `INSERT INTO topics (id, course_id, title, time_limit, is_strict, is_mock, is_correction, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, topic.courseId, topic.title, topic.timeLimit || 0, topic.isStrict ? 1 : 0, topic.isMock ? 1 : 0, topic.isCorrection ? 1 : 0, topic.sortOrder || 0]
  );
  return id;
}

export async function updateTopic(id, fields) {
  const setClauses = [];
  const args = [];
  if (fields.title !== undefined) { setClauses.push('title = ?'); args.push(fields.title); }
  if (fields.timeLimit !== undefined) { setClauses.push('time_limit = ?'); args.push(fields.timeLimit); }
  args.push(id);
  return execute(`UPDATE topics SET ${setClauses.join(', ')} WHERE id = ?`, args);
}

export async function deleteTopic(id) {
  return execute('DELETE FROM questions WHERE topic_id = ?', [id])
    .then(() => execute('DELETE FROM topics WHERE id = ?', [id]));
}

// Questions
export async function getQuestions(topicId) {
  trackRead('questions/' + topicId);
  return exec('SELECT * FROM questions WHERE topic_id = ? ORDER BY sort_order ASC', [topicId]);
}

export async function createQuestion(q) {
  return execute(
    `INSERT INTO questions (topic_id, course_id, question, option_a, option_b, option_c, option_d, correct_index, explanation, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [q.topicId, q.courseId, q.question, q.optionA || '', q.optionB || '', q.optionC || '', q.optionD || '', q.correctIndex, q.explanation || '', q.sortOrder || 0]
  );
}

export async function updateQuestion(id, q) {
  return execute(
    `UPDATE questions SET question = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_index = ?, explanation = ?
     WHERE id = ?`,
    [q.question, q.optionA || '', q.optionB || '', q.optionC || '', q.optionD || '', q.correctIndex, q.explanation || '', id]
  );
}

export async function deleteQuestion(id) {
  return execute('DELETE FROM questions WHERE id = ?', [id]);
}
