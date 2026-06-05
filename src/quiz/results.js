// Quiz results — calculation, display, save to database

import { examState } from './init.js';
import { calculateResults, stopTimer } from './engine.js';
import { gradeFromScore, getExaTitle } from '../utils/constants.js';

export function showResults() {
  stopTimer();
  const results = calculateResults();
  const grade = gradeFromScore(results.score);
  
  // Render results view
  const container = document.getElementById('quiz-container') || document.body;
  
  let html = '<div style="max-width:700px;margin:40px auto;padding:20px;text-align:center;">';
  html += '<div style="font-size:3rem;font-weight:900;color:' + (results.score >= 70 ? '#16a34a' : '#dc2626') + ';">' + results.score + '%</div>';
  html += '<div style="font-size:1.5rem;font-weight:700;margin:8px 0;">Grade ' + grade.grade + '</div>';
  html += '<div style="color:var(--text-muted);margin-bottom:24px;">' + results.correct + ' of ' + results.total + ' correct</div>';
  
  // Corrections review
  if (examState.isCorrection || examState.isMockExam) {
    html += '<div style="text-align:left;max-height:400px;overflow-y:auto;">';
    results.details.forEach((d, i) => {
      const isCorrect = d.isCorrect;
      html += '<div class="card" style="padding:16px;margin-bottom:12px;border-left:4px solid ' + (isCorrect ? '#16a34a' : '#dc2626') + ';">';
      html += '<div style="font-weight:600;margin-bottom:8px;font-size:0.85rem;">' + (i + 1) + '. ' + d.question + '</div>';
      d.options.forEach((opt, oi) => {
        const isSelected = d.selectedIndex === oi;
        const isAnswer = d.correctIndex === oi;
        let style = 'padding:6px 10px;margin:4px 0;border-radius:6px;font-size:0.8rem;';
        if (isAnswer) style += 'background:#d1fae5;color:#065f46;font-weight:700;';
        else if (isSelected && !isCorrect) style += 'background:#fee2e2;color:#991b1b;';
        else style += 'background:var(--bg-inset);';
        html += '<div style="' + style + '">' + String.fromCharCode(65 + oi) + '. ' + opt + (isAnswer ? ' ✓' : '') + '</div>';
      });
      if (d.explanation) html += '<div style="margin-top:8px;padding:8px 12px;background:#fff7ed;border-radius:6px;font-size:0.75rem;color:#9a3412;"><strong>Explanation:</strong> ' + d.explanation + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }
  
  html += '<button class="btn btn-primary" style="margin-top:24px;" onclick="window.location.href=\'/app.html\'">Return to Dashboard</button>';
  html += '</div>';
  
  container.innerHTML = html;
}

// Calculate EXA rating change
export function calculateExaChange(oldRating, score) {
  // Simple ELO-like system
  const expected = 800; // baseline expected performance
  const k = 32;
  const change = Math.round(k * ((score / 100) - (expected / 1000)));
  return Math.max(-50, Math.min(50, change));
}

// Save results to database (to be called after submission)
export async function saveResults(userId) {
  // This will be wired to the database in the entry point
  const results = calculateResults();
  return { ...results, exaChange: calculateExaChange(800, results.score) };
}
