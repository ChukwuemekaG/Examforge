import { getState } from './core.js';
import { getExaTitle, gradeFromScore, EXA_TITLES } from '../utils/constants.js';
import { getAnalytics, getWeeklyBest, computeStreakDisplay } from '../utils/analytics.js';
import * as ranking from '../db/ranking.js';

export async function renderDashboard() {
  const { userData, workspace } = getState();
  const stats = userData.stats || {};
  const exaRating = stats.exaRating || 800;
  const exaTitle = getExaTitle(exaRating);
  const results = userData.results || [];
  const analytics = getAnalytics(results);
  const weekly = getWeeklyBest(results);
  const streakInfo = computeStreakDisplay(stats);
  
  // Get national ranking (1 read)
  let nationalStats = { rank: '-', total: '-', percentile: 100 };
  try {
    nationalStats = await ranking.getNationalRanking(exaRating);
  } catch (e) {
    console.warn('Ranking unavailable:', e);
  }

  const percentileTag = nationalStats.percentile <= 60
    ? `<div class="tag tag-green" style="font-size:0.7rem;font-weight:900;padding:2px 8px;">TOP ${nationalStats.percentile}%</div>`
    : '';

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Dashboard</div>
    <div class="page-sub">${exaTitle.name} • RANK ${exaTitle.roman}</div>
  </div>
  <div class="card-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:24px;">
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">bolt</span>EXA Rating</div>
      <div class="stat-value" data-ef-exa>${exaRating}</div>
      <div style="font-size:0.62rem;color:var(--text-muted);margin-top:4px;font-weight:600;">${exaTitle.name}</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">local_fire_department</span>Streak</div>
      <div class="stat-value" data-ef-streak>${streakInfo.streak}</div>
      <div style="font-size:0.6rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Best: ${streakInfo.highest} days</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">analytics</span>Accuracy</div>
      <div class="stat-value">${analytics.avg}%</div>
      <div style="font-size:0.62rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Cumulative</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">assignment</span>Total Exams</div>
      <div class="stat-value">${analytics.count}</div>
      <div style="font-size:0.6rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Completed Sessions</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">grade</span>Avg. Grade</div>
      <div class="stat-value">${results.length > 0 ? gradeFromScore(analytics.avg).grade : '—'}</div>
      <div style="font-size:0.62rem;color:var(--text-muted);margin-top:4px;font-weight:600;">Letter Standing</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">military_tech</span>Weekly Best</div>
      <div class="stat-value">${weekly.score}%</div>
      <div style="font-size:0.6rem;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${weekly.course}</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label"><span class="material-icons-round">workspace_premium</span>High Score</div>
      <div class="stat-value">${analytics.bestScore}%</div>
      <div style="font-size:0.6rem;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${analytics.bestCourse}</div>
    </div>
    <div class="card stat-card card-accent" style="background:var(--brand);">
      <div class="stat-label" style="color:#fff!important;"><span class="material-icons-round" style="color:#fff!important;">public</span>National Rank</div>
      <div class="stat-value" style="color:#fff!important;">#${nationalStats.rank}</div>
      <div style="font-size:0.6rem;color:rgba(255,255,255,0.85)!important;margin-top:4px;font-weight:600;">${percentileTag}</div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:16px;padding:20px 24px;background:var(--bg-inset);border-radius:16px;margin-bottom:24px;">
    <div style="width:56px;height:56px;border-radius:50%;background:var(--brand);display:flex;align-items:center;justify-content:center;">
      <span class="material-icons-round" style="font-size:28px;color:#fff;" data-ef-exa-icon>${exaTitle.icon}</span>
    </div>
    <div>
      <div style="font-weight:900;font-size:1.1rem;" data-ef-exa-title>${exaTitle.name}</div>
      <div style="font-size:0.65rem;font-weight:800;color:var(--text-muted);" data-ef-exa-rank>RANK ${exaTitle.roman}</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:24px;" data-ef-rank-cards>
    ${EXA_TITLES.map(t => {
      const isCurrent = exaRating >= t.min && exaRating <= t.max;
      const isAchieved = exaRating >= t.min;
      const isPassed = isAchieved && !isCurrent;
      let cardBg = 'var(--bg-inset)', border = '1px solid var(--border)', opacity = '0.5', icon = t.icon, iconColor = 'var(--text-muted)';
      if (isCurrent) { cardBg = 'var(--brand)'; border = '2px solid var(--brand)'; opacity = '1'; iconColor = '#fff'; }
      else if (isPassed) { cardBg = 'var(--bg-card)'; border = '1px solid rgba(254,105,97,0.3)'; opacity = '1'; icon = 'check_circle'; iconColor = 'var(--brand)'; }
      return '<div style="background:' + cardBg + ';border:' + border + ';border-radius:12px;padding:12px 14px;opacity:' + opacity + ';transition:all 0.3s ease;"><div style="display:flex;align-items:center;gap:10px;"><span class="material-icons-round" style="font-size:1.3rem;color:' + iconColor + ';">' + icon + '</span><div><div style="font-weight:700;font-size:0.72rem;color:' + (isCurrent ? '#fff' : 'inherit') + ';">' + t.name + '</div><div style="font-size:0.6rem;font-weight:600;color:' + (isCurrent ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)') + ';">RANK ' + t.roman + '</div></div></div></div>';
    }).join('')}
  </div>

  <div class="table-wrap">
    <table><thead><tr><th>Course</th><th>Date</th><th>Score</th><th>Grade</th><th>Performance</th></tr></thead>
    <tbody>${results.length === 0
      ? '<tr><td colspan="5" style="text-align:center;padding:40px 0;color:var(--text-muted);">No results recorded yet.</td></tr>'
      : results.slice(0, 10).map(r => '<tr><td>' + (r.course || 'Exam') + '</td><td style="font-family:var(--font-mono);font-size:0.72rem;">' + (r.date || '') + '</td><td style="font-weight:700;">' + (r.score || 0) + '%</td><td><span class="tag ' + ((r.score || 0) >= 70 ? 'tag-green' : 'tag-muted') + '">' + (r.grade || 'F') + '</span></td><td><div class="progress-track"><div class="progress-fill" style="width:' + (r.score || 0) + '%;"></div></div></td></tr>').join('')}
    </tbody></table>
  </div>`;
}

export function updateDashboardUI() {
  const { userData } = getState();
  const exaRating = userData.stats?.exaRating ?? 800;
  const exaTitle = getExaTitle(exaRating);
  
  const exaEl = document.querySelector('[data-ef-exa]');
  if (exaEl) exaEl.textContent = exaRating;
  const streakEl = document.querySelector('[data-ef-streak]');
  if (streakEl) streakEl.textContent = userData.stats?.streak ?? 0;
  
  const iconEl = document.querySelector('[data-ef-exa-icon]');
  const titleEl = document.querySelector('[data-ef-exa-title]');
  const rankEl = document.querySelector('[data-ef-exa-rank]');
  if (iconEl && exaTitle?.icon) iconEl.textContent = exaTitle.icon;
  if (titleEl && exaTitle?.name) titleEl.textContent = exaTitle.name;
  if (rankEl && exaTitle?.roman) rankEl.textContent = 'RANK ' + exaTitle.roman;
  
  const rankCardsEl = document.querySelector('[data-ef-rank-cards]');
  if (rankCardsEl) {
    rankCardsEl.innerHTML = EXA_TITLES.map(t => {
      const isCurrent = exaRating >= t.min && exaRating <= t.max;
      const isPassed = exaRating >= t.min && !isCurrent;
      let cardBg = 'var(--bg-inset)', border = '1px solid var(--border)', opacity = '0.5', icon = t.icon, iconColor = 'var(--text-muted)';
      if (isCurrent) { cardBg = 'var(--brand)'; border = '2px solid var(--brand)'; opacity = '1'; iconColor = '#fff'; }
      else if (isPassed) { cardBg = 'var(--bg-card)'; border = '1px solid rgba(254,105,97,0.3)'; opacity = '1'; icon = 'check_circle'; iconColor = 'var(--brand)'; }
      return '<div style="background:' + cardBg + ';border:' + border + ';border-radius:12px;padding:12px 14px;opacity:' + opacity + ';"><div style="display:flex;align-items:center;gap:10px;"><span class="material-icons-round" style="font-size:1.3rem;color:' + iconColor + ';">' + icon + '</span><div><div style="font-weight:700;font-size:0.72rem;color:' + (isCurrent ? '#fff' : 'inherit') + ';">' + t.name + '</div><div style="font-size:0.6rem;font-weight:600;color:' + (isCurrent ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)') + ';">RANK ' + t.roman + '</div></div></div></div>';
    }).join('');
  }
}
