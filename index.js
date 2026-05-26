document.addEventListener('DOMContentLoaded', () => {
    
    // --- 13. THEME TOGGLE LOGIC (UPDATED FOR CHECKBOXES) ---
    const themeCheckboxes = document.querySelectorAll('.theme-toggle-checkbox');

    function setTheme(themeName) {
        document.documentElement.setAttribute('data-theme', themeName);
        localStorage.setItem('examforge-theme', themeName);
        
        // Keep all toggles in sync across the different views
        const isDark = themeName === 'dark';
        themeCheckboxes.forEach(cb => {
            if (cb.checked !== isDark) {
                cb.checked = isDark;
            }
        });
    }

    // Ensure state matches the HTML initialization on page load
    const initialTheme = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(initialTheme);

    // Attach listener to all toggle sliders
    themeCheckboxes.forEach(cb => {
        cb.addEventListener('change', (e) => {
            const nextTheme = e.target.checked ? 'dark' : 'light';
            setTheme(nextTheme);
        });
    });

    // --- Live Forge Terminal Logic ---
    const terminalFeed = document.getElementById('terminalFeed');
    const logs = [
        "[USER_882]: Completed WAEC Physics Past Questions. Score: 85%.",
        "[SYSTEM]: 1,204 MAT 102 questions solved today.",
        "[USER_019]: Initiated JAMB Simulation (Use of English).",
        "[SYSTEM]: New Microbiology quiz loaded into the matrix.",
        "[USER_999]: Achieved perfect score in Calculus & Limits.",
        "[SYSTEM]: Server load nominal. Forge burning at optimal temperature.",
        "[USER_421]: Reviewed performance analytics for Chemistry."
    ];
    let logIndex = 0;

    function addTerminalLog() {
        if (!terminalFeed) return;
        
        const p = document.createElement('p');
        p.className = 'terminal-line';
        p.innerHTML = `<span class="terminal-prompt">&gt;</span> ${logs[logIndex]}`;
        terminalFeed.appendChild(p);
        
        // Keep only the last 5 lines visible to mimic a scrolling terminal
        if (terminalFeed.children.length > 5) {
            terminalFeed.removeChild(terminalFeed.firstChild);
        }
        
        logIndex = (logIndex + 1) % logs.length;
    }

    // Fire a new log every 2.8 seconds
    setInterval(addTerminalLog, 2800);

    // --- Strict Routing to Dashboard Core ---
    const loginBtn = document.getElementById('loginBtn');
    const getStartedBtn = document.getElementById('getStartedBtn');
    const pactBtn = document.querySelector('.pact-btn'); // New button at the bottom

    function navigateToDashboard() {
        window.location.href = 'login.html';
    }

    if (loginBtn) loginBtn.addEventListener('click', navigateToDashboard);
    if (getStartedBtn) getStartedBtn.addEventListener('click', navigateToDashboard);
    if (pactBtn) pactBtn.addEventListener('click', navigateToDashboard);
});