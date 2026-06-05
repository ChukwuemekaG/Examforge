// EXA Rating title system
export const EXA_TITLES = [
  { min: 0, max: 899, roman: 'I', name: 'New Recruit', icon: 'person' },
  { min: 900, max: 1099, roman: 'II', name: 'Apprentice', icon: 'person_outline' },
  { min: 1100, max: 1249, roman: 'III', name: 'Good Student', icon: 'school' },
  { min: 1250, max: 1399, roman: 'IV', name: 'Scholar', icon: 'auto_stories' },
  { min: 1400, max: 1549, roman: 'V', name: 'Scholar Elite', icon: 'military_tech' },
  { min: 1550, max: 1699, roman: 'VI', name: 'Prodigy', icon: 'star' },
  { min: 1700, max: 1849, roman: 'VII', name: 'Prodigy Supreme', icon: 'stars' },
  { min: 1850, max: 1999, roman: 'VIII', name: 'Genius', icon: 'workspace_premium' },
  { min: 2000, max: 2199, roman: 'IX', name: 'Apex Scholar', icon: 'diamond' },
  { min: 2200, max: 9999, roman: 'X', name: 'Examforge Legend', icon: 'emoji_events' },
];

export function getExaTitle(rating) {
  return EXA_TITLES.find(t => rating >= t.min && rating <= t.max) || EXA_TITLES[0];
}

// Grade scale
export function gradeFromScore(score) {
  if (score >= 70) return { grade: 'A', points: 5.0, remark: 'Excellent' };
  if (score >= 60) return { grade: 'B', points: 4.0, remark: 'Very Good' };
  if (score >= 50) return { grade: 'C', points: 3.0, remark: 'Good' };
  if (score >= 45) return { grade: 'D', points: 2.0, remark: 'Fair' };
  if (score >= 40) return { grade: 'E', points: 1.0, remark: 'Pass' };
  return { grade: 'F', points: 0.0, remark: 'Fail' };
}

export function gpaComment(gpa) {
  if (gpa >= 4.5) return 'Excellent! First Class Honours';
  if (gpa >= 3.5) return 'Very Good! Second Class Upper (2:1)';
  if (gpa >= 2.5) return 'Good! Second Class Lower (2:2)';
  if (gpa >= 1.5) return 'Fair! Third Class';
  if (gpa >= 1.0) return 'Pass';
  return 'You need to put in a lot of work for improvement.';
}

export const DEFAULT_EXA_RATING = 800;
