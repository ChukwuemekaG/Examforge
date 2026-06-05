// Quiz exam engine — timer, navigation, submission

import { examState } from './init.js';

let timerInterval = null;

export function startTimer(onTick, onExpire) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    examState.timeRemaining--;
    if (onTick) onTick(examState.timeRemaining);
    if (examState.timeRemaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      if (onExpire) onExpire();
    }
  }, 1000);
}

export function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
}

export function goToQuestion(index) {
  if (index >= 0 && index < examState.questions.length) {
    examState.currentIndex = index;
    return true;
  }
  return false;
}

export function answerQuestion(index, selectedIndex) {
  if (index >= 0 && index < examState.questions.length) {
    examState.answers[index] = selectedIndex;
    return true;
  }
  return false;
}

export function getAnsweredCount() {
  return examState.answers.filter(a => a !== null).length;
}

export function getUnansweredCount() {
  return examState.answers.filter(a => a === null).length;
}

export function calculateResults() {
  let correct = 0;
  const details = examState.questions.map((q, i) => {
    const isCorrect = examState.answers[i] === q.correctIndex;
    if (isCorrect) correct++;
    return {
      questionIndex: i,
      question: q.question,
      options: q.options,
      correctIndex: q.correctIndex,
      selectedIndex: examState.answers[i],
      isCorrect,
      explanation: q.explanation || ''
    };
  });
  
  const total = examState.questions.length;
  const score = total > 0 ? Math.round((correct / total) * 100) : 0;
  
  return { correct, total, score, details, timeTaken: examState.timeLimit * 60 - examState.timeRemaining };
}

export function shuffleQuestions() {
  if (!examState.isStrict) {
    for (let i = examState.questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [examState.questions[i], examState.questions[j]] = [examState.questions[j], examState.questions[i]];
      [examState.answers[i], examState.answers[j]] = [examState.answers[j], examState.answers[i]];
    }
  }
}
