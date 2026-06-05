import { execOne, exec, trackRead } from './client.js';

export async function getNationalRanking(userRating) {
  trackRead('ranking/' + userRating);
  const higher = await execOne('SELECT COUNT(*) as count FROM users WHERE exa_rating > ?', [userRating]);
  const total = await execOne('SELECT COUNT(*) as count FROM users');
  const higherCount = higher?.count || 0;
  const totalUsers = total?.count || 0;
  const exactRank = higherCount + 1;
  const displayTotal = Math.max(totalUsers, exactRank);
  const percentile = exactRank === 1 ? 1 : Math.floor((exactRank / displayTotal) * 100);
  return { rank: exactRank, total: displayTotal, percentile };
}

export async function getUsersByRating(limit = 100) {
  return exec('SELECT id, display_name, exa_rating FROM users ORDER BY exa_rating DESC LIMIT ?', [limit]);
}
