import { getState } from './core.js';
import { getAnalytics, getAccuracyTrend } from '../utils/analytics.js';
import { gradeFromScore } from '../utils/constants.js';

export function renderResults() {
  const { userData, workspace } = getState();
  const results = userData.results || [];
  const analytics = getAnalytics(results);

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Results</div>
    <div class="page-sub">Performance History & Analytics</div>
  </div>
  <div class="card-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:24px;">
    <div class="card stat-card"><div class="stat-label"><span class="material-icons-round">analytics</span>Accuracy</div><div class="stat-value">${analytics.avg}%</div><div style="font-size:0.62rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Cumulative</div></div>
    <div class="card stat-card"><div class="stat-label"><span class="material-icons-round">assignment</span>Total Exams</div><div class="stat-value">${analytics.count}</div><div style="font-size:0.62rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Completed Sessions</div></div>
    <div class="card stat-card"><div class="stat-label"><span class="material-icons-round">grade</span>Avg. Grade</div><div class="stat-value">${results.length > 0 ? gradeFromScore(analytics.avg).grade : '—'}</div><div style="font-size:0.62rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Letter Standing</div></div>
    <div class="card stat-card"><div class="stat-label"><span class="material-icons-round">workspace_premium</span>High Score</div><div class="stat-value">${analytics.bestScore}%</div><div style="font-size:0.6rem;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${analytics.bestCourse}</div></div>
  </div>
  <div class="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th>Score</th><th>Grade</th><th>Performance</th></tr></thead><tbody>
    ${results.length === 0 ? '<tr><td colspan="5" style="text-align:center;padding:40px 0;color:var(--text-muted);">No results recorded yet.</td></tr>'
      : results.map(r => '<tr><td>' + (r.course || 'Exam') + '</td><td style="font-family:var(--font-mono);font-size:0.72rem;">' + (r.date || '') + '</td><td style="font-weight:700;">' + (r.score || 0) + '%</td><td><span class="tag ' + ((r.score || 0) >= 70 ? 'tag-green' : 'tag-muted') + '">' + (r.grade || 'F') + '</span></td><td><div class="progress-track"><div class="progress-fill" style="width:' + (r.score || 0) + '%;"></div></div></td></tr>').join('')}
  </tbody></table>
  ${results.length > 50 ? '<div style="text-align:center;padding:16px 0;font-size:0.68rem;color:var(--text-muted);">Showing last ' + results.length + ' sessions (Max 50)</div>' : ''}
  </div>`;
}
