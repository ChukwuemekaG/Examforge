export function getAnalytics(results) {
  const list = results || [];
  if (list.length === 0) return { avg: 0, count: 0, bestScore: 0, bestCourse: '-' };
  let total = 0, best = 0, bestCourse = '-';
  list.forEach(r => {
    total += r.score || 0;
    if ((r.score || 0) > best) { best = r.score; bestCourse = r.course || '-'; }
  });
  return { avg: Math.round(total / list.length), count: list.length, bestScore: best, bestCourse };
}

export function getWeeklyBest(results) {
  const week = Date.now() - 7 * 86400000;
  const weekResults = (results || []).filter(r => new Date(r.date || r.created_at).getTime() > week);
  if (weekResults.length === 0) return { score: 0, course: '-' };
  let best = 0, course = '-';
  weekResults.forEach(r => { if ((r.score || 0) > best) { best = r.score; course = r.course || '-'; } });
  return { score: best, course };
}

export function getAccuracyTrend(results) {
  const list = (results || []).slice(-10);
  if (list.length === 0) return [];
  return list.map(r => ({ date: r.date || r.created_at, score: r.score || 0 }));
}

export function computeStreakDisplay(stats) {
  const streak = stats?.streak || 0;
  const highest = stats?.highestStreak || 0;
  return { streak, highest, message: streak > 0 ? `${streak} day${streak === 1 ? '' : 's'}` : 'No streak' };
}
