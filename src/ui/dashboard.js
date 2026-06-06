// Dashboard — rebuilt to match original layout

import { getState } from './core.js';
import { getExaTitle, gradeFromScore, EXA_TITLES } from '../utils/constants.js';
import { getAnalytics } from '../utils/analytics.js';
import * as ranking from '../db/ranking.js';

function renderRankCardHTML(title, exaRating) {
  const isCurrent = exaRating >= title.min && exaRating <= title.max;
  const isAchieved = exaRating >= title.min;
  const isPassed = isAchieved && !isCurrent;
  let cardBg = 'var(--bg-inset)', border = '1px solid var(--border)', opacity = '0.5', icon = title.icon, iconColor = 'var(--text-muted)', textColor = 'var(--text-muted)';
  if (isCurrent) { cardBg = 'var(--brand)'; border = '2px solid var(--brand)'; opacity = '1'; iconColor = '#ffffff'; textColor = '#ffffff'; }
  else if (isPassed) { cardBg = 'var(--bg-card)'; border = '1px solid var(--brand-glow, rgba(254,105,97,0.3))'; opacity = '1'; icon = 'check_circle'; iconColor = 'var(--brand)'; textColor = 'inherit'; }
  return '<div style="background:' + cardBg + ';border:' + border + ';border-radius:12px;padding:12px 14px;opacity:' + opacity + ';transition:all 0.3s ease;"><div style="display:flex;align-items:center;gap:10px;"><span class="material-icons-round" style="font-size:1.3rem;color:' + iconColor + ';">' + icon + '</span><div><div style="font-weight:700;font-size:0.72rem;color:' + (isCurrent ? '#ffffff' : textColor) + ';">' + title.name + '</div><div style="font-size:0.6rem;font-weight:600;color:' + (isCurrent ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)') + ';">RANK ' + title.roman + '</div></div></div></div>';
}

function getAccuracyTrend(results) {
  const list = results || [];
  if (list.length < 2) return { direction: 'flat', delta: 0, lastScore: list.length > 0 ? list[list.length - 1].score : 0 };
  const last = list[list.length - 1].score || 0;
  const prev = list[list.length - 2].score || 0;
  const delta = last - prev;
  return { direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', delta: Math.abs(delta), lastScore: last };
}

function getWeeklyBest(results) {
  const week = Date.now() - 7 * 86400000;
  const weekResults = (results || []).filter(r => new Date(r.date || r.created_at).getTime() > week);
  if (weekResults.length === 0) return { score: null, course: 'None yet' };
  let best = 0, course = 'None yet';
  weekResults.forEach(r => { if ((r.score || 0) > best) { best = r.score; course = r.course || ''; } });
  return { score: best, course };
}

export async function renderDashboard() {
  const { userData, workspace } = getState();
  const stats = userData.stats || {};
  const exaRating = stats.exaRating || 800;
  const exaTitle = getExaTitle(exaRating);
  const displayName = userData.displayName || '';
  const firstName = displayName.split(' ')[0] || 'Student';
  const results = userData.results || [];
  const schedule = userData.schedule || [];
  const analytics = getAnalytics(results);
  const trend = getAccuracyTrend(results);
  const weeklyBest = getWeeklyBest(results);
  const streak = stats.streak || 0;
  const highestStreak = stats.highestStreak || 0;

  let nationalStats = { rank: '-', total: '-', percentile: 100 };
  try { nationalStats = await ranking.getNationalRanking(exaRating); } catch (e) { console.warn('Ranking unavailable:', e); }

  const percentileTag = nationalStats.percentile <= 60
    ? '<div class="tag tag-green" style="font-size:0.7rem;font-weight:900;padding:2px 8px;">TOP ' + nationalStats.percentile + '%</div>'
    : '';

  const trendIcon = trend.direction === 'up' ? 'trending_up' : trend.direction === 'down' ? 'trending_down' : 'trending_flat';
  const trendColor = trend.direction === 'up' ? '#16a34a' : trend.direction === 'down' ? '#dc2626' : 'var(--text-muted)';
  const trendLabel = trend.direction === 'up' ? '+' + trend.delta + '%' : trend.direction === 'down' ? '-' + trend.delta + '%' : 'No change';

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-header-row" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;">
      <div>
        <div class="page-title dashboard-title" style="font-size:1.75rem;font-weight:800;">Dashboard</div>
        <div class="page-sub" style="color:var(--text-muted);font-weight:800;font-size:0.85rem;">Welcome back, ${firstName}</div>
      </div>
      <button class="btn btn-primary" onclick="window.navigate('library')" style="display:flex;align-items:center;gap:8px;">
        <span class="material-icons-round">add</span> Start Exam
      </button>
    </div>
  </div>

  <div class="card" style="padding:0;margin-bottom:24px;border:1px solid var(--border);border-left:6px solid var(--brand);background:var(--bg-card);overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:24px;gap:24px;">
      <div style="flex:1;min-width:280px;">
        <div style="font-weight:800;font-size:0.65rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.12em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <span class="material-icons-round" style="font-size:0.9rem;color:var(--brand);">analytics</span> EXA RATING
        </div>
        <div style="font-family:poppins;font-size:clamp(3.5rem,8vw,4.8rem);font-weight:900;color:var(--text);line-height:0.9;margin-bottom:8px;" data-ef-exa>
          ${exaRating}
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:0.75rem;font-weight:700;color:var(--text-sub);">National Standing</span>
          ${percentileTag}
        </div>
      </div>
      <div style="padding:20px 24px;background:var(--bg-inset);border-radius:16px;border:1px solid var(--border);display:flex;align-items:center;gap:16px;min-width:260px;flex-shrink:0;">
        <div style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;background:var(--bg-card);border:2px solid var(--brand);border-radius:14px;">
          <span class="material-icons-round" style="font-size:2.2rem;color:var(--brand);" data-ef-exa-icon>${exaTitle.icon}</span>
        </div>
        <div>
          <div style="font-weight:900;font-size:1.1rem;text-transform:uppercase;color:var(--text);line-height:1.1;" data-ef-exa-title>
            ${exaTitle.name}
          </div>
          <div style="font-size:0.65rem;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);margin-top:4px;letter-spacing:0.05em;" data-ef-exa-rank>
            RANK ${exaTitle.roman}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div style="margin-bottom:32px;">
    <div style="font-weight:800;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:16px;display:flex;align-items:center;gap:8px;">
      <span class="material-icons-round" style="font-size:1rem;">map</span> Progress Roadmap
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;overflow-x:auto;" data-ef-rank-cards>
      ${EXA_TITLES.map(t => renderRankCardHTML(t, exaRating)).join('')}
    </div>
  </div>

  <div class="card-grid card-grid-strict" style="margin-bottom:24px;display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">
    <div class="card stat-card card-accent" style="background:var(--brand);border-color:var(--brand);margin:0;min-width:0;">
      <div class="stat-label" style="color:#ffffff!important;"><span class="material-icons-round" style="color:#ffffff!important;">public</span> National Rank</div>
      <div class="stat-value" style="color:#ffffff!important;word-wrap:break-word;">#${nationalStats.rank}</div>
    </div>
    <div class="card stat-card" style="margin:0;min-width:0;">
      <div class="stat-label"><span class="material-icons-round">gps_fixed</span> Accuracy</div>
      <div class="stat-value" style="word-wrap:break-word;">${analytics.avg}%</div>
      <div class="stat-delta" style="color:${trendColor};display:flex;align-items:center;gap:3px;font-size:0.62rem;margin-top:4px;font-weight:700;">
        <span class="material-icons-round" style="font-size:0.9rem;">${trendIcon}</span> ${trendLabel} vs last
      </div>
    </div>
    <div class="card stat-card" style="margin:0;min-width:0;">
      <div class="stat-label"><span class="material-icons-round">local_fire_department</span> Streak</div>
      <div class="stat-value" style="word-wrap:break-word;" data-ef-streak>${streak}d</div>
      <div class="stat-delta" style="font-size:0.62rem;font-weight:600;" data-ef-high-streak>Best: ${highestStreak}d</div>
    </div>
    <div class="card stat-card" style="margin:0;min-width:0;">
      <div class="stat-label"><span class="material-icons-round">stars</span> Weekly Best</div>
      <div class="stat-value" style="word-wrap:break-word;">${weeklyBest.score !== null ? weeklyBest.score + '%' : '—'}</div>
      <div style="font-size:0.6rem;color:var(--text-muted);margin-top:4px;font-weight:600;word-wrap:break-word;">${weeklyBest.course || 'None yet'}</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;align-items:start;" id="dashboard-lower-grid">
    <div class="card" style="padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <span style="font-weight:800;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;">Recent History</span>
        <button class="btn btn-ghost btn-sm" onclick="window.navigate('results')">View All</button>
      </div>
      <div class="feed">
        ${results.length === 0
          ? '<div style="text-align:center;padding:24px 0;color:var(--text-muted);font-size:0.8rem;">No results yet. Start an exam!</div>'
          : results.slice(0, 4).map(r => {
            const score = r.score || 0;
            const icon = score >= 70 ? 'check_circle' : 'radio_button_checked';
            return '<div class="feed-item" onclick="window.navigate(\'results\')" style="cursor:pointer;border-radius:8px;padding:8px;margin:0 -8px;transition:background 0.2s;"><div class="feed-icon" style="color:' + (score >= 70 ? '#16a34a' : '#dc2626') + ';"><span class="material-icons-round">' + icon + '</span></div><div class="feed-body"><div class="feed-title" style="font-weight:700;font-size:0.85rem;">' + (r.course || 'Exam') + '</div><div class="feed-meta">' + (r.date || '') + '</div></div><div class="feed-score" style="color:var(--text);font-weight:800;">' + score + '%</div></div>';
          }).join('')}
      </div>
    </div>
    <div class="card" style="padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <span style="font-weight:800;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;">Coming Up</span>
        <button class="btn btn-ghost btn-sm" onclick="window.navigate('schedule')">Full Schedule</button>
      </div>
      <div class="feed">
        ${schedule.length === 0
          ? '<div style="text-align:center;padding:24px 0;color:var(--text-muted);font-size:0.8rem;">No upcoming items.</div>'
          : schedule.slice(0, 4).map(s => '<div class="feed-item"><div class="feed-icon"><span class="material-icons-round">calendar_today</span></div><div class="feed-body"><div class="feed-title" style="font-weight:700;font-size:0.85rem;">' + (s.course || s.title || 'Mock Exam') + '</div><div class="feed-meta">' + (s.date || 'Available now') + (s.time ? ' · ' + s.time : '') + '</div></div></div>').join('')}
      </div>
    </div>
  </div>

  <div class="dashboard-profile-card" style="margin-top:16px;">
    <button onclick="window.navigate('settings')" style="width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-card);border:3px solid var(--text);border-radius:12px;cursor:pointer;font-weight:700;font-size:0.85rem;color:var(--text);">
      <div style="width:40px;height:40px;border-radius:8px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;">
        <span class="material-icons-round" style="font-size:1.1rem;">person</span>
      </div>
      <div style="flex:1;text-align:left;">
        <div style="font-weight:800;font-size:0.85rem;">Profile & Settings</div>
        <div style="font-size:0.7rem;color:var(--text-muted);">Theme, notifications, account</div>
      </div>
      <span class="material-icons-round" style="color:var(--text-muted);">chevron_right</span>
    </button>
  </div>`;
}

export function updateDashboardUI() {
  const { userData } = getState();
  const exaRating = userData.stats?.exaRating ?? 800;
  const exaTitle = getExaTitle(exaRating);
  const streak = userData.stats?.streak ?? 0;
  const highestStreak = userData.stats?.highestStreak ?? 0;
  
  const exaEl = document.querySelector('[data-ef-exa]');
  if (exaEl) exaEl.textContent = exaRating;
  const streakEl = document.querySelector('[data-ef-streak]');
  if (streakEl) streakEl.textContent = streak + 'd';
  const highStreakEl = document.querySelector('[data-ef-high-streak]');
  if (highStreakEl) highStreakEl.textContent = 'Best: ' + highestStreak + 'd';
  
  const iconEl = document.querySelector('[data-ef-exa-icon]');
  const titleEl = document.querySelector('[data-ef-exa-title]');
  const rankEl = document.querySelector('[data-ef-exa-rank]');
  if (iconEl && exaTitle?.icon) iconEl.textContent = exaTitle.icon;
  if (titleEl && exaTitle?.name) titleEl.textContent = exaTitle.name;
  if (rankEl && exaTitle?.roman) rankEl.textContent = 'RANK ' + exaTitle.roman;
  
  const rankCardsEl = document.querySelector('[data-ef-rank-cards]');
  if (rankCardsEl) {
    rankCardsEl.innerHTML = EXA_TITLES.map(t => renderRankCardHTML(t, exaRating)).join('');
  }
}
