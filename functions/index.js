const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Triggered when a notification document is written to any user's notifications subcollection
exports.sendPushNotification = functions.firestore
    .document('users/{uid}/notifications/{notifId}')
    .onCreate(async (snap, context) => {
        const { uid } = context.params;
        const notification = snap.data();
        
        // Don't send push for old/delayed notifications
        const now = Date.now();
        const notifTime = notification.timestamp?.toMillis ? notification.timestamp.toMillis() : now;
        if (now - notifTime > 60000) return; // Skip if older than 1 minute
        
        try {
            // Get the user's FCM token
            const userDoc = await admin.firestore().doc(`users/${uid}`).get();
            if (!userDoc.exists) return;
            
            const userData = userDoc.data();
            const fcmToken = userData.fcmToken;
            if (!fcmToken) return; // No FCM token - can't send push
            
            // Build notification title
            const typeMap = {
                warning: '⚠️ Alert',
                broadcast: '📢 Broadcast',
                congratulatory: '🎉 Achievement',
                gift: '🎁 Gift',
                daily_quiz: '📝 Daily Quiz',
                advice: '💡 Daily Advice'
            };
            
            const title = notification.title || typeMap[notification.type] || 'ExamForge';
            const body = notification.message || '';
            
            // Determine click action URL
            let clickUrl = '/app.html#inbox';
            if (notification.actionPath) {
                clickUrl = notification.actionPath;
            } else if (notification.type === 'advice') {
                clickUrl = '/app.html#inbox';
            } else if (notification.type === 'daily_quiz' && notification.quizUrl) {
                clickUrl = notification.quizUrl;
            }
            
            // Send FCM message
            const message = {
                token: fcmToken,
                notification: {
                    title: title,
                    body: body.substring(0, 200), // Truncate long messages
                },
                data: {
                    title: title,
                    body: body,
                    url: clickUrl,
                    type: notification.type || 'broadcast',
                    timestamp: String(Date.now())
                },
                webpush: {
                    notification: {
                        icon: '/examforge.jpeg',
                        badge: '/512.png',
                        image: '/examforge.jpeg',
                        vibrate: [200, 100, 200],
                        requireInteraction: true,
                        tag: `ef-${context.params.notifId}`,
                        data: { url: clickUrl }
                    },
                    fcm_options: {
                        link: clickUrl
                    }
                }
            };
            
            await admin.messaging().send(message);
            console.log(`Push sent to ${uid}: ${title}`);
            
        } catch (error) {
            // If token is invalid, remove it
            if (error.code === 'messaging/invalid-registration-token' || 
                error.code === 'messaging/registration-token-not-registered') {
                try {
                    await admin.firestore().doc(`users/${uid}`).update({
                        fcmToken: admin.firestore.FieldValue.delete()
                    });
                } catch(e) {}
            }
            console.error(`FCM error for ${uid}:`, error.message);
        }
    });
