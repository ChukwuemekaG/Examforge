// Quiz initialization — parses URL, loads exam data from Turso

import { getURLParam } from '../utils/helpers.js';
import * as courses from '../db/courses.js';
import * as quizzes from '../db/quizzes.js';
import * as mocks from '../db/mocks.js';

export const examState = {
  questions: [],
  currentIndex: 0,
  answers: [],
  timeLimit: 0,
  timeRemaining: 0,
  timer: null,
  quizId: null,
  courseId: null,
  title: '',
  isMockExam: false,
  isDailyQuiz: false,
  isCourseMode: false,
  isStrict: false,
  isCorrection: false,
  subjectTabs: []
};

export async function initQuiz() {
  const mockid = getURLParam('mockid');
  const dqid = getURLParam('dqid');
  const courseId = getURLParam('course');
  const topicId = getURLParam('topic');

  examState.quizId = mockid || dqid || null;
  examState.courseId = courseId || null;

  if (mockid) {
    // Mock exam
    examState.isMockExam = true;
    const mockData = await mocks.getMock(mockid);
    if (!mockData) throw new Error('Mock exam not found');
    examState.title = mockData.subject || 'Mock Exam';
    examState.timeLimit = mockData.time_limit || 0;
    const questions = JSON.parse(mockData.questions || '[]');
    examState.questions = questions;
    examState.answers = new Array(questions.length).fill(null);
    examState.timeRemaining = examState.timeLimit * 60;
    examState.subjectTabs = [{ id: mockid, label: mockData.subject || 'Exam', count: questions.length }];
    return { type: 'mock', data: mockData };
  }

  if (dqid) {
    // Daily quiz
    examState.isDailyQuiz = true;
    const quizData = await quizzes.getQuiz(dqid);
    if (!quizData) throw new Error('Daily quiz not found');
    examState.title = quizData.title || 'Daily Quiz';
    examState.timeLimit = quizData.time_limit || 0;
    const quizQuestions = await quizzes.getQuizQuestions(dqid);
    examState.questions = quizQuestions.map(q => ({
      id: q.id, question: q.question,
      options: [q.option_a, q.option_b, q.option_c, q.option_d],
      correctIndex: q.correct_index, explanation: q.explanation || ''
    }));
    examState.answers = new Array(examState.questions.length).fill(null);
    examState.timeRemaining = examState.timeLimit * 60;
    return { type: 'daily_quiz', data: quizData };
  }

  if (courseId) {
    // Course mode (full course or single topic)
    examState.isCourseMode = true;
    const courseData = await courses.getCourse(courseId);
    if (!courseData) throw new Error('Course not found');
    examState.title = courseData.title || 'Course Exam';
    
    let allQuestions = [];
    const topics = await courses.getTopics(courseId);
    
    if (topicId) {
      const topic = topics.find(t => t.id === topicId);
      if (topic) {
        const qs = await courses.getQuestions(topicId);
        allQuestions = qs.map(q => ({
          id: q.id, question: q.question,
          options: [q.option_a, q.option_b, q.option_c, q.option_d],
          correctIndex: q.correct_index, explanation: q.explanation || '',
          topicId, topicTitle: topic.title
        }));
        examState.subjectTabs = [{ id: topicId, label: topic.title, count: allQuestions.length }];
      }
    } else {
      // Load all topics' questions
      for (const topic of topics) {
        const qs = await courses.getQuestions(topic.id);
        const mapped = qs.map(q => ({
          id: q.id, question: q.question,
          options: [q.option_a, q.option_b, q.option_c, q.option_d],
          correctIndex: q.correct_index, explanation: q.explanation || '',
          topicId: topic.id, topicTitle: topic.title
        }));
        allQuestions = allQuestions.concat(mapped);
        examState.subjectTabs.push({ id: topic.id, label: topic.title, count: mapped.length });
      }
    }
    
    examState.questions = allQuestions;
    examState.answers = new Array(allQuestions.length).fill(null);
    examState.timeLimit = courseData.total_time_limit || 0;
    examState.timeRemaining = examState.timeLimit * 60;
    examState.isStrict = courseData.is_strict === 1;
    examState.isCorrection = courseData.is_correction === 1;
    return { type: 'course', data: courseData };
  }

  throw new Error('No valid quiz parameters found');
}
