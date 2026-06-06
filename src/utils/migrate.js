// Firestore → Turso Migration Script
// Run from admin panel to bring existing Firestore data into Turso

import { collection, getDocs, doc, getDoc, orderBy, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { db } from '../../firebase-config.js';
import * as users from '../db/users.js';
import * as courses from '../db/courses.js';
import * as quizzes from '../db/quizzes.js';
import * as advices from '../db/advices.js';
import * as events from '../db/events.js';
import * as mocks from '../db/mocks.js';
import * as schedules from '../db/schedules.js';
import * as notifications from '../db/notifications.js';
import * as counters from '../db/counters.js';
import * as admin from '../db/admin.js';

let migrated = 0;
let errors = 0;

function log(msg) {
  console.log('[Migrate]', msg);
}

function err(msg) {
  console.error('[Migrate] ERROR:', msg);
  errors++;
}

export async function runMigration(onProgress) {
  migrated = 0; errors = 0;
  const totalSteps = 9;
  let step = 0;

  // STEP 1: Migrate Users
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating users...`);
  try {
    const snap = await getDocs(collection(db, 'users'));
    log(`Found ${snap.size} users in Firestore`);
    for (const d of snap.docs) {
      const u = d.data();
      try {
        // Check if already in Turso — UPDATE instead of skip
        const existing = await users.getUser(d.id);
        
        if (existing) {
          // Update existing user with Firestore data
          await users.updateUserData(d.id, {
            exaRating: u.exaRating ?? 800,
            displayName: u.displayName || '',
            username: u.username || '',
            streak: u.streak || 0,
            highestStreak: u.highestStreak || 0,
            lastExamDate: u.lastExamDate || null
          });
        } else {
          // Create new user
          await users.createUser({
            id: d.id, email: u.email || '', displayName: u.displayName || '',
            username: u.username || '', provider: u.provider || 'firebase',
            exaRating: u.exaRating || 800, role: u.role || 'student'
          });
          if (u.streak || u.highestStreak || u.lastExamDate) {
            await users.updateUserData(d.id, {
              streak: u.streak || 0, highestStreak: u.highestStreak || 0,
              lastExamDate: u.lastExamDate || null
            });
          }
        }
        migrated++;
        
        // Migrate schedule array
        if (u.schedule && Array.isArray(u.schedule)) {
          for (const s of u.schedule) {
            await users.addScheduleItem(d.id, s);
          }
        }
        // Migrate inbox array
        if (u.inbox && Array.isArray(u.inbox)) {
          for (const item of u.inbox) {
            await users.addInboxItem(d.id, item);
          }
        }
        // Migrate recentResults array
        if (u.recentResults && Array.isArray(u.recentResults)) {
          for (const r of u.recentResults) {
            await users.addResult(d.id, r);
          }
        }
      } catch (e) { err(`User ${d.id}: ${e.message}`); }
    }
    log(`Users done: ${migrated} migrated, ${errors} errors`);
  } catch (e) { err(`Users collection: ${e.message}`); }

  // STEP 2: Migrate Courses + Topics + Questions
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating courses...`);
  try {
    const courseSnap = await getDocs(collection(db, 'unicourses'));
    log(`Found ${courseSnap.size} courses in Firestore`);
    for (const d of courseSnap.docs) {
      const c = d.data();
      try {
        await courses.createCourse({
          id: d.id, title: c.title || '', level: c.level || '',
          totalTimeLimit: c.totalTimeLimit || 0, isStrict: !!c.isStrict,
          isMock: !!c.isMock, isCorrection: !!c.isCorrection
        });
        migrated++;
        
        // Get topics subcollection
        const topicSnap = await getDocs(collection(db, 'unicourses', d.id, 'topics'));
        let sortOrder = 0;
        for (const tDoc of topicSnap.docs) {
          const t = tDoc.data();
          try {
            await courses.createTopic({
              id: tDoc.id, courseId: d.id, title: t.title || '',
              timeLimit: t.timeLimit || 0, isStrict: !!t.isStrict,
              isMock: !!t.isMock, isCorrection: !!t.isCorrection, sortOrder: sortOrder++
            });
            // Migrate questions
            const questions = t.questions || [];
            for (let qi = 0; qi < questions.length; qi++) {
              const q = questions[qi];
              const opts = q.options || ['', '', '', ''];
              await courses.createQuestion({
                topicId: tDoc.id, courseId: d.id,
                question: q.question || '', optionA: opts[0] || '', optionB: opts[1] || '',
                optionC: opts[2] || '', optionD: opts[3] || '',
                correctIndex: q.correctIndex ?? 0, explanation: q.explanation || '',
                sortOrder: qi
              });
            }
          } catch (e2) { err(`Topic ${tDoc.id}: ${e2.message}`); }
        }
      } catch (e) { err(`Course ${d.id}: ${e.message}`); }
    }
  } catch (e) { err(`Courses collection: ${e.message}`); }

  // STEP 3: Migrate Daily Quizzes
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating daily quizzes...`);
  try {
    const snap = await getDocs(collection(db, 'daily_quizzes'));
    log(`Found ${snap.size} daily quizzes in Firestore`);
    for (const d of snap.docs) {
      const q = d.data();
      try {
        await quizzes.createQuiz({
          id: d.id, title: q.title || '', timeLimit: q.timeLimit || 0,
          maxAttempts: q.maxAttempts || 1
        });
        migrated++;
        // Migrate questions
        const questions = q.questions || [];
        if (questions.length > 0) {
          await quizzes.setQuizQuestions(d.id, questions);
        }
        // Migrate attempts
        const attempts = q.attempts || q.lastAttempts || {};
        for (const [uid, att] of Object.entries(attempts)) {
          try {
            await quizzes.saveQuizAttempt(d.id, uid, {
              score: att.score || 0, correct: att.correct || 0,
              total: att.total || 0, timeTaken: att.timeTaken || 0,
              answers: att.answers || []
            });
          } catch (ea) { /* skip individual attempt errors */ }
        }
      } catch (e) { err(`Quiz ${d.id}: ${e.message}`); }
    }
  } catch (e) { err(`Daily quizzes: ${e.message}`); }

  // STEP 4: Migrate Daily Advice
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating daily advice...`);
  try {
    const snap = await getDocs(collection(db, 'daily_advices'));
    log(`Found ${snap.size} advice entries in Firestore`);
    for (const d of snap.docs) {
      const a = d.data();
      try {
        await advices.createAdvice({
          id: d.id, title: a.title || '', category: a.category || '',
          content: a.content || ''
        });
        migrated++;
      } catch (e) { err(`Advice ${d.id}: ${e.message}`); }
    }
  } catch (e) { err(`Daily advices: ${e.message}`); }

  // STEP 5: Migrate Subscription Events
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating events...`);
  try {
    const snap = await getDocs(collection(db, 'subscription_events'));
    log(`Found ${snap.size} events in Firestore`);
    for (const d of snap.docs) {
      const ev = d.data();
      try {
        await events.createEvent({
          id: d.id, title: ev.title || '', description: ev.description || '',
          availableSubjects: ev.availableSubjects || [],
          maxSubjects: ev.maxSubjects || 0,
          resultsReleased: !!ev.resultsReleased
        });
        migrated++;
        // Migrate registrations from _data/registrations
        try {
          const regDoc = await getDoc(doc(db, 'subscription_events', d.id, '_data', 'registrations'));
          if (regDoc.exists()) {
            const students = regDoc.data().students || [];
            for (const s of students) {
              try {
                await events.registerStudent(d.id, {
                  uid: s.uid, displayName: s.displayName || '',
                  email: s.email || '', subjects: s.subjects || []
                });
              } catch (er) { /* skip individual reg errors */ }
            }
          }
        } catch (er) { /* skip subcollection errors */ }
        // Migrate keys
        try {
          const keySnap = await getDocs(collection(db, 'subscription_events', d.id, 'keys'));
          for (const kDoc of keySnap.docs) {
            const k = kDoc.data();
            try {
              await events.createEventKey(d.id, kDoc.id);
              if (k.usedBy) {
                await events.useKey(d.id, kDoc.id, k.usedBy);
              }
            } catch (ek) { /* skip */ }
          }
        } catch (er) { /* skip */ }
      } catch (e) { err(`Event ${d.id}: ${e.message}`); }
    }
  } catch (e) { err(`Events: ${e.message}`); }

  // STEP 6: Migrate Mock Exams + Attempts
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating mock exams...`);
  try {
    const snap = await getDocs(collection(db, 'mock_exams'));
    log(`Found ${snap.size} mock exams in Firestore`);
    for (const d of snap.docs) {
      const m = d.data();
      try {
        await mocks.createMock({
          id: d.id, eventId: m.eventId || '', subject: m.subject || '',
          title: m.title || '', timeLimit: m.timeLimit || 0
        });
        if (m.questions) {
          await mocks.updateMockQuestions(d.id, m.questions);
        }
        migrated++;
        // Migrate attempts subcollection
        try {
          const attSnap = await getDocs(collection(db, 'mock_exams', d.id, 'attempts'));
          for (const aDoc of attSnap.docs) {
            const a = aDoc.data();
            try {
              await mocks.saveMockAttempt(d.id, {
                uid: a.uid || aDoc.id, displayName: a.displayName || '',
                email: a.email || '', score: a.score || 0, correct: a.correct || 0,
                total: a.totalQuestions || a.total || 0, timeTaken: a.timeTaken || 0,
                answers: a.answers || [], browserAgent: a.browserAgent || '',
                platform: a.platform || '', screenResolution: a.screenResolution || ''
              });
            } catch (ea) { /* skip */ }
          }
        } catch (er) { /* skip subcollection */ }
      } catch (e) { err(`Mock ${d.id}: ${e.message}`); }
    }
  } catch (e) { err(`Mocks: ${e.message}`); }

  // STEP 7: Migrate Broadcast Notifications
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating notifications...`);
  try {
    const snap = await getDoc(doc(db, '_notifications', 'latest'));
    if (snap.exists()) {
      const items = snap.data().items || [];
      log(`Found ${items.length} broadcast notifications`);
      for (const n of items) {
        try {
          await notifications.addBroadcastNotification(n);
          migrated++;
        } catch (e) { err(`Notification: ${e.message}`); }
      }
    }
  } catch (e) { err(`Notifications: ${e.message}`); }

  // STEP 8: Migrate Broadcast Schedules
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating schedules...`);
  try {
    const snap = await getDoc(doc(db, '_schedules', 'latest'));
    if (snap.exists()) {
      const items = snap.data().items || [];
      log(`Found ${items.length} broadcast schedules`);
      for (const s of items) {
        try {
          await schedules.addBroadcastSchedule(s);
          migrated++;
        } catch (e) { err(`Schedule: ${e.message}`); }
      }
    }
  } catch (e) { err(`Schedules: ${e.message}`); }

  // STEP 9: Migrate Counters + Admin Panel
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating counters...`);
  try {
    const counterSnap = await getDoc(doc(db, '_stats', 'counters'));
    if (counterSnap.exists()) {
      const val = counterSnap.data().totalUsers || 0;
      await counters.setCounter('totalUsers', val);
      log(`Counter totalUsers = ${val}`);
    }
    const adminSnap = await getDoc(doc(db, '_admin_panel', 'data'));
    if (adminSnap.exists()) {
      const a = adminSnap.data();
      await admin.updateAdminPanel({
        courses: a.courses || [],
        dailyQuizzes: a.daily_quizzes || [],
        dailyAdvices: a.daily_advices || [],
        subscriptionEvents: a.subscription_events || [],
        totalStudentCount: a.total_student_count || 0
      });
    }
    migrated++;
  } catch (e) { err(`Counters/admin: ${e.message}`); }

  const result = { migrated, errors };
  log(`Migration complete: ${result.migrated} items migrated, ${result.errors} errors`);
  return result;
}
