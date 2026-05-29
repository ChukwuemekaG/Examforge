import fs from 'fs';

const filePath = 'C:/Projects/Examforge/app.js';
let content = fs.readFileSync(filePath, 'utf8');

const oldFuncStart = content.indexOf('async function renderDashboard()');
const newFuncStart = 'function fixTwoCol()';
const newFuncIdx = content.indexOf(newFuncStart, oldFuncStart);

if (oldFuncStart === -1 || newFuncIdx === -1) {
    console.error('Could not find function boundaries');
    process.exit(1);
}

// Find the actual closing brace of renderDashboard
// It's the last } before fixTwoCol
const beforeFixTwoCol = content.substring(oldFuncStart, newFuncIdx);
// Find the last } in this segment (the closing brace of renderDashboard)
const lastBrace = beforeFixTwoCol.lastIndexOf('}');
if (lastBrace === -1) {
    console.error('Could not find closing brace');
    process.exit(1);
}

const endOfFunc = oldFuncStart + lastBrace + 1;

const oldContent = content.substring(oldFuncStart, endOfFunc);

const newContent = `    async function renderDashboard() {
        renderLoading(" ");
        
        // ─── Load cached data for faster display ───
        const cached = dcGet();
        if (cached) {
            userData.results = cached.results || userData.results;
            if (cached.stats) userData.stats = { ...userData.stats, ...cached.stats };
            userData.schedule = cached.schedule || userData.schedule;
        }
        
        // ─── Fetch fresh user data for accurate stats and schedule ───
        try {
            const { getDoc, doc, collection, getDocs, query, orderBy } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
            const userSnap = await getDoc(doc(db, 'users', auth.currentUser.uid));
            if (userSnap.exists()) {
                const freshData = userSnap.data();
                if (freshData.stats) {
                    userData.stats = { ...userData.stats, ...freshData.stats };
                }
            }
            // Fetch schedule items
            const schedSnap = await getDocs(query(collection(db, \`users/\${auth.currentUser.uid}/schedule\`), orderBy('timestamp', 'asc')));
            if (!schedSnap.empty) {
                userData.schedule = schedSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
            }
        } catch (e) { console.error("Failed to fetch user data:", e); }
        
        // ─── Save to cache for next time ──
        try {
            const ranking = await getNationalRanking(userData.stats.exaRating || 800);
            dcSet({ results: userData.results, stats: userData.stats, schedule: userData.schedule, ranking });
        } catch(e) {}
        
        // ─── Data & Analytics ───
        const analytics = getAnalytics();
        const firstName = currentUser.displayName ? currentUser.displayName.split(' ')[0] : 'Student';
        const streakData = computeStreakDisplay(userData.stats);
        const streak = streakData.streak;
        const weeklyBest = getWeeklyBest(userData.results);
        const trend = getAccuracyTrend(userData.results);
        const exaRating = userData.stats.exaRating || 800;
        const exaTitle = getExaTitle(exaRating);

        // Fetch National Positioning
        const nationalStats = cached?.ranking || await getNationalRanking(exaRating);

        // Create the percentile tag only if it's 60% or better
        const percentileTag = nationalStats.percentile <= 60
            ? \`<div class="tag tag-green" style="font-size: 0.7rem; font-weight: 900; padding: 2px 8px;">TOP \${nationalStats.percentile}%</div>\`
            : '';

        // UI Helpers for Trends
        const trendIcon = trend.direction === 'up' ? 'trending_up' : trend.direction === 'down' ? 'trending_down' : 'trending_flat';
        const trendColor = trend.direction === 'up' ? '#16a34a' : trend.direction === 'down' ? 'var(--brand)' : 'var(--text-muted)';
        const trendLabel = trend.direction === 'up' ? \`+\${trend.delta}%\` : trend.direction === 'down' ? \`-\${trend.delta}%\` : '0%';

        workspace.innerHTML = \`
            <style>
                .dash-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; margin-bottom:16px; }
                .dash-stat { background:var(--bg-card); border:2px solid var(--border); border-radius:var(--r-md); padding:14px; display:flex; flex-direction:column; }
                .dash-stat .val { font-family:poppins; font-size:clamp(1.4rem,5vw,2.2rem); font-weight:800; color:var(--text); line-height:1; }
                .dash-stat .lbl { font-family:poppins; font-size:0.6rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em; margin-top:4px; display:flex; align-items:center; gap:4px; }
                @media(max-width:480px){ .dash-grid { grid-template-columns:1fr 1fr; gap:8px; } }
                .dash-feed-item { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.15s; border-radius:4px; margin:0 -4px; padding:6px 4px; }
                .dash-feed-item:hover { background:var(--bg-inset); }
                .dash-feed-item:last-child { border-bottom:none; }
            </style>
            <div class="page-header" style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; width:100%; flex-wrap:wrap; gap:8px;">
                    <div>
                        <div class="page-title" style="font-size:clamp(1rem,4vw,1.4rem);">Good \${new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 17 ? 'Afternoon' : 'Evening'}, \${firstName}.</div>
                        <div class="page-sub" style="font-size:0.65rem;">\${streakData.broken ? 'Resume your streak' : streak > 0 ? streak + ' day streak' : 'Start your streak'} \u00b7 \${weeklyBest.score !== null ? 'Best: ' + weeklyBest.score + '%' : 'Take your first exam'}</div>
                    </div>
                </div>
            </div>
            
            <div class="dash-grid">
                <div class="dash-stat">
                    <div class="lbl"><span class="material-icons-round" style="font-size:0.8rem;">gps_fixed</span> Accuracy</div>
                    <div class="val">\${analytics.avg}%</div>
                </div>
                <div class="dash-stat">
                    <div class="lbl"><span class="material-icons-round" style="font-size:0.8rem;">assignment</span> Exams</div>
                    <div class="val">\${analytics.count}</div>
                </div>
                <div class="dash-stat">
                    <div class="lbl"><span class="material-icons-round" style="font-size:0.8rem;">analytics</span> EXA Rating</div>
                    <div class="val">\${exaRating}</div>
                    <div style="font-size:0.6rem;font-weight:700;color:var(--text-muted);margin-top:2px;">\${exaTitle.name}</div>
                </div>
                <div class="dash-stat">
                    <div class="lbl"><span class="material-icons-round" style="font-size:0.8rem;">trending_up</span> Trend</div>
                    <div class="val" style="color:\${trendColor};font-size:clamp(1rem,4vw,1.5rem);">\${trendLabel}</div>
                </div>
            </div>
            
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div style="background:var(--bg-card);border:2px solid var(--border);border-radius:var(--r-md);padding:12px;">
                    <div style="font-weight:700;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;color:var(--text-muted);">Coming Up</div>
                    \${userData.schedule.length === 0 ? \`
                        <div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.7rem;background:var(--bg-inset);border-radius:6px;border:1px dashed var(--border);">
                            <span class="material-icons-round" style="font-size:1.2rem;display:block;margin-bottom:4px;opacity:0.5;">event_busy</span>
                            <div style="font-weight:600;">Nothing scheduled</div>
                        </div>
                    \` : userData.schedule.slice(0, 4).map(s => \`
                        <div class="dash-feed-item">
                            <span class="material-icons-round" style="font-size:0.85rem;color:var(--text-muted);flex-shrink:0;">calendar_today</span>
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:600;font-size:0.72rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${s.course || s.title || 'Exam'}</div>
                                <div style="font-size:0.6rem;color:var(--text-muted);margin-top:1px;">\${s.date || ''}\${s.date && s.time ? ' \u00b7 ' : ''}\${s.time || 'Available now'}</div>
                            </div>
                        </div>
                    \`).join('')}
                </div>
                <div style="background:var(--bg-card);border:2px solid var(--border);border-radius:var(--r-md);padding:12px;">
                    <div style="font-weight:700;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;color:var(--text-muted);">Recent</div>
                    \${userData.results.length === 0 ? \`
                        <div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.7rem;background:var(--bg-inset);border-radius:6px;border:1px dashed var(--border);">
                            <span class="material-icons-round" style="font-size:1.2rem;display:block;margin-bottom:4px;opacity:0.5;">assignment</span>
                            <div style="font-weight:600;">No exams taken yet</div>
                        </div>
                    \` : userData.results.slice(0, 4).map(r => \`
                        <div class="dash-feed-item" onclick="efNavigate('results')">
                            <div style="width:22px;height:22px;border-radius:4px;background:\${r.score >= 80 ? 'rgba(22,163,74,0.08)' : r.score >= 50 ? 'var(--bg-inset)' : 'rgba(220,38,38,0.06)'};border:1px solid \${r.score >= 80 ? '#16a34a' : r.score >= 50 ? 'var(--border)' : '#dc2626'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <span class="material-icons-round" style="font-size:0.65rem;color:\${r.score >= 80 ? '#16a34a' : r.score >= 50 ? 'var(--text-muted)' : '#dc2626'};">\${r.score >= 80 ? 'check_circle' : 'radio_button_checked'}</span>
                            </div>
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:600;font-size:0.72rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${r.course || 'Exam'}</div>
                                <div style="font-size:0.6rem;color:var(--text-muted);margin-top:1px;">\${r.date || ''}</div>
                            </div>
                            <div style="font-weight:800;font-size:0.8rem;color:\${r.score >= 80 ? '#16a34a' : 'var(--text)'};">\${r.score}%</div>
                        </div>
                    \`).join('')}
                </div>
            </div>
            
            <div style="text-align:center;padding:10px;font-size:0.65rem;font-weight:600;color:var(--text-muted);">
                \${percentileTag ? percentileTag : '<span style="opacity:0.6;">Ranking...</span>'}
            </div>
        \`;
    }`;

const newFullContent = content.substring(0, oldFuncStart) + newContent + content.substring(endOfFunc);
fs.writeFileSync(filePath, newFullContent, 'utf8');
console.log('Replacement successful');
console.log('Old function length:', oldContent.length);
console.log('New function length:', newContent.length);
