import { getState } from './core.js';
import * as courses from '../db/courses.js';

export async function renderLibrary() {
  const { workspace } = getState();

  // RENDER IMMEDIATELY with loading state
  workspace.innerHTML = `<div class="page-header">
    <div class="page-title">Course Library</div>
    <div class="page-sub">Loading courses...</div>
  </div>
  <div style="text-align:center;padding:40px;color:var(--text-muted);">
    <span class="material-icons-round" style="font-size:2rem;">hourglass_empty</span>
    <div>Loading courses...</div>
  </div>`;

  // FETCH courses in background
  try {
    const courseList = await courses.getAllCourses();
    renderCourseList(courseList);
  } catch (e) {
    workspace.innerHTML = `<div class="page-header">
      <div class="page-title">Course Library</div>
      <div class="page-sub">0 courses available</div>
    </div>
    <div class="empty-state">
      <span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">library_books</span>
      <div style="font-weight:700;color:var(--text-muted);">No courses available</div>
    </div>`;
    console.warn('Could not load courses:', e);
  }
}

function renderCourseList(courseList) {
  const { workspace } = getState();
  
  // Group courses by level/category
  const byLevel = {};
  for (const c of courseList) {
    const level = c.level || 'General';
    if (!byLevel[level]) byLevel[level] = [];
    byLevel[level].push(c);
  }
  const levels = Object.keys(byLevel).sort();

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Course Library</div>
    <div class="page-sub">${courseList.length} courses available</div>
  </div>
  ${courseList.length === 0
    ? '<div class="empty-state"><span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">library_books</span><div style="font-weight:700;color:var(--text-muted);">No courses available</div></div>'
    : '<div style="margin-bottom:16px;"><input id="lib-search" placeholder="Search courses..." oninput="window._filterLibraryCourses()" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--border);font-size:0.9rem;background:var(--bg-inset);"></div>' +
      '<div id="lib-course-grid" class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;">' +
      levels.map(level => `
        <div style="grid-column:1/-1;font-weight:700;font-size:0.9rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:${levels.indexOf(level) > 0 ? '8px' : '0px'};margin-bottom:4px;">${level}</div>
        ${byLevel[level].map(c => {
          const topics = c.topic_count || 0;
          const desc = c.description || '';
          return '<div class="card" data-course-id="' + c.id + '" data-course-level="' + level + '" style="padding:20px;cursor:pointer;display:flex;flex-direction:column;" onclick="window.location.href=\'/quiz?course=' + c.id + '\'">' +
            '<div style="font-weight:800;font-size:1rem;margin-bottom:4px;">' + (c.title || '') + '</div>' +
            (desc ? '<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:8px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + desc + '</div>' : '') +
            '<div style="margin-top:auto;display:flex;gap:8px;flex-wrap:wrap;">' +
            (topics > 0 ? '<span class="tag tag-muted" style="font-size:0.65rem;">📚 ' + topics + ' topic' + (topics !== 1 ? 's' : '') + '</span>' : '') +
            '<span class="tag tag-muted" style="font-size:0.65rem;">' + level + '</span>' +
            '</div></div>';
        }).join('')}
      `).join('') + '</div>'
  }`;
  
  window._filterLibraryCourses = function() {
    const q = (document.getElementById('lib-search')?.value || '').toLowerCase();
    document.querySelectorAll('[data-course-id]').forEach(el => {
      const title = el.querySelector('div:first-child')?.textContent?.toLowerCase() || '';
      el.style.display = (!q || title.includes(q)) ? '' : 'none';
    });
  };
}

window._filterLibraryCourses = function() { /* placeholder - set in render */ };
