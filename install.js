/* --- install.js for EXAMFORGE --- */

let deferredPrompt;

// 1. Check if the app is already installed (i.e. currently running as PWA)
const isPWAInstalled = () => {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
};

// 2. Catch the install event but prevent it from showing automatically
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    // Show install prompt only when running in the browser and not yet installed
    if (!isPWAInstalled()) {
        setTimeout(() => {
            showBrutalistInstallModal();
        }, 1500);
    }
});

// 2b. Already installed but user is in the browser — prompt them to open the app.
//     beforeinstallprompt won't fire for installed PWAs, so we check separately.
if (!isPWAInstalled()) {
    if ('getInstalledRelatedApps' in navigator) {
        navigator.getInstalledRelatedApps().then((apps) => {
            if (apps.length > 0) {
                // PWA is installed but we're in the browser tab
                setTimeout(() => showOpenInAppModal(), 1500);
            }
        });
    }
}

// 3. Install modal
function showBrutalistInstallModal() {
    if (document.getElementById('forge-install-modal')) return;

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'forge-install-modal';

    modalOverlay.innerHTML = `
    <style>
    :root {
    scroll-behavior: smooth;
    --brand-red: #c22b27;
    --black: #2d2d32;
    --real-black: #000000;
    --real-white: #ffffff;
    --white: #f5f5f5;
    --gray-light: #d6d6d6;
    --border-thickness: 3px;
    --sharp-transition: all 0.15s linear;

    --brand:        #c22b27;
    --brand-hover:  #c22b27;
    --brand-dim: #FFD6E0;
    --bg: #FFFDF0; /* Retro off-white */
    --surface: #FFFFFF;
    --surface-alt: #F4F4F0;
    --text: #000000;
    --text-muted: #252525;
    --border: #000000;
    --success: #00E676;
    --success-dim: #B3FFD6;
    --danger-dim: #FFCCCC;
    
    /* Hard, solid brutalist shadows */
    --shadow-sm: 2px 2px 0px 0px #000000;
    --shadow-md: 4px 4px 0px 0px #000000;
    --shadow-lg: 8px 8px 0px 0px #000000;
}

@font-face {
    font-family: poppins;
    src: url(/Poppins/Poppins-Regular.ttf);
}

/* --- Dark Mode Overrides --- */
[data-theme="dark"] {
    --black: #ededed;
    --white: #1f2429;
    --gray-light: #14181c;
    --real-black: #ffffff;
    --real-white: #000000;
     --brand: #C0392B;
    --brand-hover:  #A93226;
    --brand-dim: #4A0014;
    --bg: #121212; 
    --surface: #1E1E1E;
    --surface-alt: #2A2A2A;
    --text: #FFFFFF;
    --text-muted: #AAAAAA;
    --border: #FFFFFF; /* White borders for extreme contrast */
    --success: #00E676;
    --success-dim: #00331A;
    --danger-dim: #4A0000;
    
    /* Shadows turn white (or very light) in dark mode to maintain the brutalist pop */
    --shadow-sm: 2px 2px 0px 0px #FFFFFF;
    --shadow-md: 4px 4px 0px 0px #FFFFFF;
    --shadow-lg: 8px 8px 0px 0px #FFFFFF;
}/* --- Sharp Buttons --- */
button {
    cursor: pointer;
    font-weight: 700;
    font-size: 0.95rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    border-radius: 0;
    transition: var(--sharp-transition);
}

.btn-sharp-outline {
    background: var(--white);
    color: var(--black);
    border: var(--border-thickness) solid var(--black);
    box-shadow: 4px 4px 0px var(--black);
    padding: 10px 24px;
}

.btn-sharp-outline:active {
    transform: translate(4px, 4px);
    box-shadow: 0px 0px 0px var(--black);
}

.btn-sharp-solid {
    background: var(--brand-red);
    color: #ffffff;
    border: var(--border-thickness) solid var(--black);
    padding: 16px 36px;
    box-shadow: 6px 6px 0px var(--black);
}

.btn-sharp-solid:hover { background: #e63530; }
.btn-sharp-solid:active { transform: translate(6px, 6px); box-shadow: 0px 0px 0px var(--black); }
</style>
        <div class="install-card shadow-lg" style="
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 9999;
            background: var(--white);
            border: var(--border-thickness) solid var(--black);
            box-shadow: var(--shadow-lg);
            max-width: 350px;
            padding: 0;
            display: flex;
            flex-direction: column;
            animation: fadeIn 0.3s ease-out;
        ">
            <div style="
                background: var(--brand-red);
                color: #ffffff;
                padding: 10px 15px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1px;
                border-bottom: var(--border-thickness) solid var(--black);
                display: flex;
                justify-content: space-between;
                align-items: center;
            ">
                <span>System Notification</span>
                <span id="close-forge-modal" style="cursor: pointer;">[X]</span>
            </div>
            <div style="padding: 20px; color: var(--black);">
                <h3 style="text-transform: uppercase; font-weight: 800; margin-bottom: 10px;">Forge the App</h3>
                <p style="font-size: 0.9rem; font-weight: 600; opacity: 0.9; margin-bottom: 20px; border-left: 3px solid var(--brand-red); padding-left: 10px;">
                    Install EXAMFORGE for offline access and a pure fullscreen experience.
                </p>
                <div style="display: flex; gap: 15px; flex-direction: column;">
                    <button id="confirm-install" class="btn-sharp-solid" style="width: 100%; padding: 12px;">Install App</button>
                    <button id="dismiss-install" class="btn-sharp-outline" style="width: 100%; padding: 12px; font-size: 0.8rem;">Continue in Browser</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modalOverlay);

    const closeBtn   = document.getElementById('close-forge-modal');
    const dismissBtn = document.getElementById('dismiss-install');
    const installBtn = document.getElementById('confirm-install');

    const removeModal = () => {
        modalOverlay.style.opacity = '0';
        setTimeout(() => modalOverlay.remove(), 150);
    };

    dismissBtn.onclick = removeModal;
    closeBtn.onclick   = removeModal;

    installBtn.onclick = async () => {
        removeModal();
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User response to install: ${outcome}`);
            deferredPrompt = null;
        }
    };
}

// 4. "Open in App" modal — shown when the PWA is installed but user is in a browser tab
function showOpenInAppModal() {
    if (document.getElementById('forge-open-modal')) return;
    // Don't stack with the install modal
    if (document.getElementById('forge-install-modal')) return;

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'forge-open-modal';

    modalOverlay.innerHTML = `
     <style>
    :root {
    scroll-behavior: smooth;
    --brand-red: #c22b27;
    --black: #2d2d32;
    --real-black: #000000;
    --real-white: #ffffff;
    --white: #f5f5f5;
    --gray-light: #d6d6d6;
    --border-thickness: 3px;
    --sharp-transition: all 0.15s linear;

    --brand:        #c22b27;
    --brand-hover:  #c22b27;
    --brand-dim: #FFD6E0;
    --bg: #FFFDF0; /* Retro off-white */
    --surface: #FFFFFF;
    --surface-alt: #F4F4F0;
    --text: #000000;
    --text-muted: #252525;
    --border: #000000;
    --success: #00E676;
    --success-dim: #B3FFD6;
    --danger-dim: #FFCCCC;
    
    /* Hard, solid brutalist shadows */
    --shadow-sm: 2px 2px 0px 0px #000000;
    --shadow-md: 4px 4px 0px 0px #000000;
    --shadow-lg: 8px 8px 0px 0px #000000;
}

@font-face {
    font-family: poppins;
    src: url(/Poppins/Poppins-Regular.ttf);
}

/* --- Dark Mode Overrides --- */
[data-theme="dark"] {
    --black: #ededed;
    --white: #1f2429;
    --gray-light: #14181c;
    --real-black: #ffffff;
    --real-white: #000000;
     --brand: #C0392B;
    --brand-hover:  #A93226;
    --brand-dim: #4A0014;
    --bg: #121212; 
    --surface: #1E1E1E;
    --surface-alt: #2A2A2A;
    --text: #FFFFFF;
    --text-muted: #AAAAAA;
    --border: #FFFFFF; /* White borders for extreme contrast */
    --success: #00E676;
    --success-dim: #00331A;
    --danger-dim: #4A0000;
    
    /* Shadows turn white (or very light) in dark mode to maintain the brutalist pop */
    --shadow-sm: 2px 2px 0px 0px #FFFFFF;
    --shadow-md: 4px 4px 0px 0px #FFFFFF;
    --shadow-lg: 8px 8px 0px 0px #FFFFFF;
}/* --- Sharp Buttons --- */
button {
    cursor: pointer;
    font-weight: 700;
    font-size: 0.95rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    border-radius: 0;
    transition: var(--sharp-transition);
}

.btn-sharp-outline {
    background: var(--white);
    color: var(--black);
    border: var(--border-thickness) solid var(--black);
    box-shadow: 4px 4px 0px var(--black);
    padding: 10px 24px;
}

.btn-sharp-outline:active {
    transform: translate(4px, 4px);
    box-shadow: 0px 0px 0px var(--black);
}

.btn-sharp-solid {
    background: var(--brand-red);
    color: #ffffff;
    border: var(--border-thickness) solid var(--black);
    padding: 16px 36px;
    box-shadow: 6px 6px 0px var(--black);
}

.btn-sharp-solid:hover { background: #e63530; }
.btn-sharp-solid:active { transform: translate(6px, 6px); box-shadow: 0px 0px 0px var(--black); }
</style>
        <div style="
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 9999;
            background: var(--white);
            border: var(--border-thickness) solid var(--black);
            box-shadow: var(--shadow-lg);
            max-width: 350px;
            padding: 0;
            display: flex;
            flex-direction: column;
            animation: fadeIn 0.3s ease-out;
        ">
            <div style="
                background: var(--brand-red);
                color: #ffffff;
                padding: 10px 15px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1px;
                border-bottom: var(--border-thickness) solid var(--black);
                display: flex;
                justify-content: space-between;
                align-items: center;
            ">
                <span>System Notification</span>
                <span id="close-open-modal" style="cursor: pointer;">[X]</span>
            </div>
            <div style="padding: 20px; color: var(--black);">
                <h3 style="text-transform: uppercase; font-weight: 800; margin-bottom: 10px;">App Already Installed</h3>
                <p style="font-size: 0.9rem; font-weight: 600; opacity: 0.9; margin-bottom: 20px; border-left: 3px solid var(--brand-red); padding-left: 10px;">
                    EXAMFORGE is installed on your device. Open it for the full experience.
                </p>
                <div style="display: flex; gap: 15px; flex-direction: column;">
                    <a id="open-in-app-btn" class="btn-sharp-solid" href="/" style="
                        width: 100%; padding: 12px;
                        text-align: center; display: block;
                        text-decoration: none;
                    ">Open App</a>
                    <button id="dismiss-open-modal" class="btn-sharp-outline" style="width: 100%; padding: 12px; font-size: 0.8rem;">Stay in Browser</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modalOverlay);

    const closeBtn   = document.getElementById('close-open-modal');
    const dismissBtn = document.getElementById('dismiss-open-modal');

    const removeModal = () => {
        modalOverlay.style.opacity = '0';
        setTimeout(() => modalOverlay.remove(), 150);
    };

    dismissBtn.onclick = removeModal;
    closeBtn.onclick   = removeModal;
}

// 5. Handle actual installation completion
window.addEventListener('appinstalled', () => {
    console.log('EXAMFORGE successfully forged into the system.');
    const modal = document.getElementById('forge-install-modal');
    if (modal) modal.remove();
});