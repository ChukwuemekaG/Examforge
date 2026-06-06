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
