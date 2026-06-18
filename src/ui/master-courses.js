// Admin: Courses/Topics/Questions CRUD

import * as courses from '../db/courses.js';
import { showPrompt, showConfirmAsync, showAlert } from '../utils/helpers.js';
import * as loading from './components/loading.js';

let currentCourseId = null;
let currentTopicId = null;

export async function renderMasterCourses(container) {
  let courseList = [];
  try { courseList = await courses.getAllCourses(); } catch (e) { console.warn(e); }
  
  container.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:800;font-size:1.1rem;">Courses (${courseList.length})</div>
    <button class="btn btn-primary btn-sm" onclick="window._createCourse()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Course</button>
  </div>
  <div id="course-list">
    ${courseList.length === 0 ? '<div class="empty-state">No courses yet</div>'
      : courseList.map(c => '<div class="card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;"><div style="cursor:pointer;flex:1;" onclick="window._openCourse(\'' + c.id + '\')"><div style="font-weight:700;">' + (c.title || 'Untitled') + '</div><div style="font-size:0.7rem;color:var(--text-muted);">' + (c.level || '') + (c.topic_count ? ' • ' + c.topic_count + ' topics' : '') + '</div></div><button class="btn btn-outline btn-sm" onclick="event.stopPropagation();window._deleteCourse(\'' + c.id + '\')">Delete</button></div>').join('')}
  </div>
  <div id="topic-area"></div>`;
}

window._createCourse = async function() {
  const title = await showPrompt('Course title:');
  if (!title) return;
  const level = await showPrompt('Level (e.g. 100, 200):', '100') || '100';
  try {
    loading.showLoadingOverlay('Creating course...');
    await courses.createCourse({ title, level });
    loading.hideLoadingOverlay();
    const container = document.getElementById('master-tab-content');
    if (container) await renderMasterCourses(container);
  } catch (e) { loading.hideLoadingOverlay(); showAlert('Error: ' + e.message); }
};

window._deleteCourse = async function(id) {
  if (!await showConfirmAsync('Delete this course?')) return;
  try {
    await courses.deleteCourse(id);
    const container = document.getElementById('master-tab-content');
    if (container) await renderMasterCourses(container);
  } catch (e) { alert('Error: ' + e.message); }
};

window._openCourse = async function(courseId) {
  currentCourseId = courseId;
  const topicArea = document.getElementById('topic-area');
  if (!topicArea) return;
  
  let topicList = [];
  try { topicList = await courses.getTopics(courseId); } catch (e) { console.warn(e); }
  
  topicArea.innerHTML = `
  <div style="margin-top:16px;padding:16px;background:var(--bg-inset);border-radius:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div style="font-weight:700;font-size:0.95rem;">Topics (${topicList.length})</div>
      <button class="btn btn-primary btn-sm" onclick="window._createTopic()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Topic</button>
    </div>
    ${topicList.length === 0 ? '<div style="color:var(--text-muted);font-size:0.85rem;">No topics yet</div>'
      : topicList.map(t => '<div class="card" style="padding:12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;"><div style="cursor:pointer;flex:1;" onclick="window._openTopic(\'' + t.id + '\')"><div style="font-weight:600;font-size:0.85rem;">' + (t.title || 'Untitled') + '</div></div><button class="btn btn-outline btn-sm" onclick="event.stopPropagation();window._deleteTopic(\'' + t.id + '\')">Delete</button></div>').join('')}
  </div>
  <div id="question-area"></div>`;
};

window._createTopic = async function() {
  if (!currentCourseId) return;
  const title = await showPrompt('Topic title:');
  if (!title) return;
  try {
    await courses.createTopic({ courseId: currentCourseId, title });
    await window._openCourse(currentCourseId);
  } catch (e) { alert('Error: ' + e.message); }
};

window._deleteTopic = async function(topicId) {
  if (!await showConfirmAsync('Delete this topic and all its questions?')) return;
  try {
    await courses.deleteTopic(topicId);
    await window._openCourse(currentCourseId);
  } catch (e) { alert('Error: ' + e.message); }
};

window._openTopic = async function(topicId) {
  currentTopicId = topicId;
  const qArea = document.getElementById('question-area');
  if (!qArea) return;
  
  let questionList = [];
  try { questionList = await courses.getQuestions(topicId); } catch (e) { console.warn(e); }
  
  qArea.innerHTML = `
  <div style="margin-top:12px;padding:16px;background:var(--bg-card);border-radius:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div style="font-weight:600;font-size:0.85rem;">Questions (${questionList.length})</div>
      <button class="btn btn-primary btn-sm" onclick="window._addQuestion()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> Add Question</button>
    </div>
    ${questionList.length === 0 ? '<div style="color:var(--text-muted);font-size:0.8rem;">No questions yet</div>'
      : questionList.map((q, i) => '<div class="card" style="padding:10px;margin-bottom:6px;"><div style="display:flex;justify-content:space-between;"><div style="font-size:0.8rem;font-weight:600;flex:1;">' + (i + 1) + '. ' + (q.question || '').slice(0, 60) + (q.question?.length > 60 ? '...' : '') + '</div><button class="btn btn-outline btn-sm" style="padding:2px 6px;font-size:0.65rem;" onclick="window._deleteQuestion(\'' + q.id + '\')">✕</button></div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">A: ' + (q.option_a || '') + ' | B: ' + (q.option_b || '') + (q.correct_index === 0 ? ' ✓' : '') + '</div></div>').join('')}
  </div>`;
};

window._addQuestion = async function() {
  if (!currentTopicId || !currentCourseId) return;
  const qText = await showPrompt('Question:');
  if (!qText) return;
  const optA = await showPrompt('Option A:') || '';
  const optB = await showPrompt('Option B:') || '';
  const optC = await showPrompt('Option C:') || '';
  const optD = await showPrompt('Option D:') || '';
  const correctIdx = parseInt(await showPrompt('Correct answer index (0-3):', '0')) || 0;
  const explanation = await showPrompt('Explanation (optional):') || '';
  
  try {
    await courses.createQuestion({
      topicId: currentTopicId, courseId: currentCourseId,
      question: qText, optionA: optA, optionB: optB, optionC: optC, optionD: optD,
      correctIndex: correctIdx, explanation
    });
    await window._openTopic(currentTopicId);
  } catch (e) { alert('Error: ' + e.message); }
};

window._deleteQuestion = async function(questionId) {
  if (!await showConfirmAsync('Delete this question?')) return;
  try {
    await courses.deleteQuestion(questionId);
    await window._openTopic(currentTopicId);
  } catch (e) { alert('Error: ' + e.message); }
};
