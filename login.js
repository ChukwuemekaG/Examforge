import { auth } from './firebase-config.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    updateProfile,
    sendEmailVerification,
    GoogleAuthProvider,
    signInWithPopup,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {

    const loginFeedback = document.getElementById('loginFeedback');
    const regFeedback = document.getElementById('regFeedback');
    const tabLogin = document.getElementById('tabLogin');
    const tabRegister = document.getElementById('tabRegister');
    const formLogin = document.getElementById('formLogin');
    const formRegister = document.getElementById('formRegister');
    const loadingScreen = document.getElementById('loadingScreen'); 

    const getHumanErrorMessage = (code) => {
        switch (code) {
            case 'auth/invalid-credential': 
                return "The email or password doesn't match. Please try again.";
            case 'auth/email-already-in-use': 
                return "This email is already in our system. Try logging in!";
            case 'auth/weak-password': 
                return "Password is too short. Use at least 8 characters.";
            case 'auth/too-many-requests': 
                return "Too many attempts. Take a short break and try again.";
            case 'auth/network-request-failed':
                return "Network error. Check your connection to Examforge.";
            case 'auth/user-not-found':
                return "We couldn't find an account with that username or email.";
            default: 
                return "Something went wrong on our end. Please try again.";
        }
    };

    const showFeedback = (container, message, isError = true) => {
        if (!container) return;
        // User instruction: Show errors under inputs in human form, no alerts
        container.textContent = message.toUpperCase();
        container.style.display = 'block';
        container.style.background = isError ? '#e74c3c' : '#2ecc71'; 
    };

    const clearFeedback = () => {
        if (loginFeedback) loginFeedback.style.display = 'none';
        if (regFeedback) regFeedback.style.display = 'none';
    };

    const toggleLoading = (show) => {
        if (loadingScreen) {
            loadingScreen.style.display = show ? 'flex' : 'none';
        }
    };

    function switchTab(target) {
        clearFeedback();
        if (target === 'login') {
            tabLogin.classList.add('active');
            tabRegister.classList.remove('active');
            formLogin.classList.add('active-form');
            formRegister.classList.remove('active-form');
        } else {
            tabRegister.classList.add('active');
            tabLogin.classList.remove('active'); 
            formRegister.classList.add('active-form');
            formLogin.classList.remove('active-form');
        }
    }

    if (tabLogin && tabRegister) {
        tabLogin.addEventListener('click', () => switchTab('login'));
        tabRegister.addEventListener('click', () => switchTab('register'));
    }

    if (formRegister) {
        // --- UPDATED REGISTRATION IN login.js ---
formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFeedback();
    toggleLoading(true);

    const fullName = document.getElementById('regName').value.trim();
    const username = document.getElementById('regUsername').value.toLowerCase().trim();
    const email = document.getElementById('regEmail').value.toLowerCase().trim();
    const password = document.getElementById('regPassword').value;

    try {
        const { default: usersModule } = await import('./src/db/users.js');
        const existingUser = await usersModule.getUsername(username);
        
        if (existingUser) {
            toggleLoading(false);
            showFeedback(regFeedback, "SORRY, THAT USERNAME IS ALREADY TAKEN.");
            return;
        }

        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        // 1. Update Auth Profile
        await updateProfile(user, { displayName: fullName });

        // 2. Create the MASTER User Record with Provider Info
        await usersModule.createUser({
            id: user.uid,
            email: email,
            displayName: fullName,
            username: username,
            provider: 'password',
            exaRating: 800,
            role: 'student'
        });

        // Increment total user count for national ranking
        const { default: countersModule } = await import('./src/db/counters.js');
        try {
            await countersModule.incrementCounter('totalUsers');
        } catch (e) {
            console.warn('Could not update user counter:', e);
        }

        // Write totalUsers to this user's doc for ranking
        try {
            const totalUsers = await countersModule.getCounter('totalUsers');
            if (totalUsers > 0) {
                await usersModule.updateUserData(user.uid, { totalUsers });
            }
        } catch (e) {
            console.warn('Could not write totalUsers:', e);
        }

        // 3. Map Username for Login
        await usersModule.createUsername(username, user.uid, email);
        
        await sendEmailVerification(user, { url: 'https://examforge.com.ng/verify.html', handleCodeInApp: true });
        window.location.href = '/go-verify.html';
        
    } catch (error) {
        console.error(error);
        toggleLoading(false);
        showFeedback(regFeedback, getHumanErrorMessage(error.code));
    }
});
    }

    if (formLogin) {
        formLogin.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearFeedback();
            toggleLoading(true);

            const identifier = document.getElementById('loginIdentifier').value.toLowerCase().trim();
            const password = document.getElementById('loginPassword').value;

            let emailToAuth = identifier;

            try {
                // If the identifier doesn't have an @, it is likely a username
                if (!identifier.includes('@')) {
                    // Check localStorage cache first — skip Firestore read for returning users
                    const cachedEmail = localStorage.getItem('ef_username_' + identifier);
                    if (cachedEmail) {
                        emailToAuth = cachedEmail;
                    } else {
                        const { default: usersModule } = await import('./src/db/users.js');
                        const userRecord = await usersModule.getUsername(identifier);

                        if (userRecord) {
                            emailToAuth = userRecord.email;
                            localStorage.setItem('ef_username_' + identifier, emailToAuth);
                        } else {
                            toggleLoading(false);
                            showFeedback(loginFeedback, "USERNAME NOT FOUND.");
                            return;
                        }
                    }
                }

                const userCredential = await signInWithEmailAndPassword(auth, emailToAuth, password);
                const user = userCredential.user;

                if (!user.emailVerified) {
                    toggleLoading(false);
                    showFeedback(loginFeedback, "PLEASE VERIFY YOUR EMAIL BEFORE LOGGING IN.");
                    await signOut(auth); 
                    return;
                }

                window.location.href = '/app.html';
            } catch (error) {
                console.error(error);
                toggleLoading(false);
                showFeedback(loginFeedback, getHumanErrorMessage(error.code));
            }
        });
    }

    const googleProvider = new GoogleAuthProvider();
    const handleGoogleAuth = async () => {
        clearFeedback();
        toggleLoading(true);
        try {
            await signInWithPopup(auth, googleProvider);
            window.location.href = '/app.html';
        } catch (error) {
            toggleLoading(false);
            const container = formLogin.classList.contains('active-form') ? loginFeedback : regFeedback;
            console.error(error);
            showFeedback(container, getHumanErrorMessage(error.code));
        }
    };

    document.querySelectorAll('.btn-google-login, .btn-google-reg').forEach(btn => {
        btn.addEventListener('click', handleGoogleAuth);
    });
});