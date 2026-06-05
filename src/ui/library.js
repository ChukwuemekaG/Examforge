import { getState } from './core.js';
import * as courses from '../db/courses.js';

export async function renderLibrary() {
  const { workspace } = getState();
  let courseList = [];
  try {
    courseList = await courses.getAllCourses();
  } catch (e) { console.warn('Could not load courses:', e); }

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Course Library</div>
    <div class="page-sub">${courseList.length} courses available</div>
  </div>
  ${courseList.length === 0
    ? '<div class="empty-state"><span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">library_books</span><div style="font-weight:700;color:var(--text-muted);">No courses available</div></div>'
    : '<div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;">' + courseList.map(c => {
        return '<div class="card" style="padding:20px;cursor:pointer;" onclick="window.location.href=\'/quiz?course=' + c.id + '\'"><div style="font-weight:800;font-size:1rem;margin-bottom:4px;">' + (c.title || '') + '</div><div style="font-size:0.7rem;color:var(--text-muted);">' + (c.level || '') + (c.topic_count ? ' • ' + c.topic_count + ' topics' : '') + '</div></div>';
      }).join('') + '</div>'
  }`;
}
