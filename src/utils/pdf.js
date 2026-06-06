// PDF generation for result sheets — delegates to printResultSheet

import { showAlert } from './helpers.js';

let cssCache = null;

export function getResultSheetCSS() {
  if (cssCache) return cssCache;
  cssCache = `
    @page { margin: 10mm; size: A4 portrait; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Poppins', sans-serif; color: #18160F; font-size: 15px; line-height: 1.6; -webkit-print-color-adjust: exact; print-color-adjust: exact; position: relative; background: #fbfcff; padding: 20px; }
    body::before { content: ''; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 600px; height: 600px; background-image: url('/examforge.jpeg'); background-size: contain; background-repeat: no-repeat; background-position: center; opacity: 0.04; pointer-events: none; z-index: -1; }
    .result-container { max-width: 210mm; margin: 0 auto; position: relative; z-index: 1; }
    .top-bar { display: flex; align-items: center; gap: 16px; padding: 20px 24px; background: #FFFFFF; border: 2px solid #6d6d6d; margin-bottom: 28px; }
    .top-bar .title-area h1 span { color: #fe6961; }
    .event-banner { background: #fe6961; color: #FFFFFF; padding: 14px 20px; font-size: 20px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; border: 2px solid #6d6d6d; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: #FFFFFF; border: 2px solid #6d6d6d; }
    table th { background: #18160F; color: #FFFFFF; padding: 10px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; border: 1px solid #333; text-align: center; }
    table td { padding: 10px 8px; border: 1px solid #666; text-align: center; font-size: 14px; font-weight: 600; color: #353637; }
    .grade-A { color: #16a34a; font-weight: 800; }
    .grade-B { color: #2563eb; font-weight: 800; }
    .grade-C { color: #ca8a04; font-weight: 800; }
    .grade-D { color: #d97706; font-weight: 800; }
    .grade-E { color: #b06030; font-weight: 800; }
    .grade-F { color: #dc2626; font-weight: 800; }
    .na-subject { color: #999; font-style: italic; }
    .summary-card.gpa-card { background: #fe6961; color: #FFFFFF; border-color: #18160F; }
    .summary-card .s-value { font-size: 32px; font-weight: 900; }
    .summary-card.gpa-card .s-value { color: #FFFFFF; }
    .comment-box { background: #FFFFFF; border: 2px solid #18160F; padding: 16px 20px; margin-bottom: 24px; }
    .grade-ref { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 24px; padding: 12px 16px; background: #FFFFFF; border: 1px solid #666; }
    .signature-row { display: flex; justify-content: space-between; margin-top: 32px; padding: 0 10px; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 2px solid #666; font-size: 9px; color: #3a3b3d; text-align: center; }
    @media (max-width: 600px) { .info-grid, .summary-grid { grid-template-columns: 1fr; } }
  `;
  return cssCache;
}

// Build result sheet HTML from data
export function buildResultSheetHTML(eventTitle, studentData, gpa, gpaComment) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const studentName = studentData.displayName || 'N/A';
  const studentEmail = studentData.email || '';
  const rows = (studentData.subjects || []).map(s => {
    if (s.score === null || s.score === undefined || s.grade === null) {
      return '<tr><td style="text-align:left;">' + s.name + '</td><td>' + s.creditUnit + '</td><td class="na-subject" colspan="3">Not attempted</td><td class="na-subject">—</td><td class="na-subject">—</td></tr>';
    }
    const g = s.grade;
    return '<tr><td style="text-align:left;">' + s.name + '</td><td>' + s.creditUnit + '</td><td>' + s.correct + '/' + s.total + '</td><td>' + s.score + '%</td><td class="grade-' + g.grade + '">' + g.grade + '</td><td>' + g.points.toFixed(1) + '</td><td style="font-size:11px;">' + g.remark + '</td></tr>';
  }).join('');
  const totalCU = (studentData.subjects || []).reduce((sum, s) => sum + (s.creditUnit || 0), 0);

  return '<div class="top-bar"><div class="title-area"><h1>Exam<span>Forge</span></h1><div class="sub">Official Result Sheet</div></div></div>' +
    '<div class="event-banner">' + eventTitle + '</div>' +
    '<div class="info-grid"><div class="info-card"><div class="label">Student</div><div class="value">' + studentName + '</div></div><div class="info-card"><div class="label">Email</div><div class="value">' + studentEmail + '</div></div><div class="info-card"><div class="label">Date Issued</div><div class="value">' + dateStr + '</div></div></div>' +
    '<table><thead><tr><th style="text-align:left;">Course</th><th>CU</th><th>Score</th><th>%</th><th>Grade</th><th>GP</th><th style="text-align:left;">Remark</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="summary-grid"><div class="summary-card"><div class="s-label">Total Credit Units</div><div class="s-value">' + totalCU + '</div></div><div class="summary-card gpa-card"><div class="s-label">GPA</div><div class="s-value">' + (gpa || 0).toFixed(2) + '</div></div></div>' +
    '<div class="comment-box"><div class="c-label">Academic Comment</div><div class="c-text">' + (gpaComment || '') + '</div></div>' +
    '<div class="grade-ref"><span class="grade-ref-item">A = 5.0</span><span class="grade-ref-item">B = 4.0</span><span class="grade-ref-item">C = 3.0</span><span class="grade-ref-item">D = 2.0</span><span class="grade-ref-item">E = 1.0</span><span class="grade-ref-item">F = 0.0</span></div>' +
    '<div class="footer"><p>This is a computer-generated transcript. All results are final.</p></div>';
}

// Print result as PDF (opens new tab with auto-download)
export function printResultSheet(html) {
  const fullDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>ExamForge - Result Sheet</title><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"><style>' + getResultSheetCSS() + '</style></head><body><div class="result-container">' + html + '</div><script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script><script>setTimeout(function(){var el=document.querySelector(\'.result-container\');if(!el)return;html2pdf().set({margin:[10,10,10,10],filename:\'ExamForge_Result_Sheet.pdf\',image:{type:\'jpeg\',quality:0.98},html2canvas:{scale:2,useCORS:true,letterRendering:true,backgroundColor:\'#fbfcff\'},jsPDF:{unit:\'mm\',format:\'a4\',orientation:\'portrait\'}}).from(el).save()},1500);<\/script></body></html>';

  try {
    const blob = new Blob([fullDoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) showAlert('Please allow popups to download the PDF.');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) {
    const win = window.open('', '_blank');
    if (win) { win.document.write(fullDoc); win.document.close(); }
    else showAlert('Please allow popups to download the PDF.');
  }
}

// Window-level print function (called from onclick)
window.printResultSheet = printResultSheet;
