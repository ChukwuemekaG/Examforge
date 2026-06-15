// Firestore → Turso Migration Script
// Run from admin panel to bring existing Firestore data into Turso
// Supports resume: skips documents already in Turso on re-run

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
let skipped = 0;

function log(msg) {
  console.log('[Migrate]', msg);
}

function err(msg) {
  console.error('[Migrate] ERROR:', msg);
  errors++;
}

export async function runMigration(onProgress) {
  migrated = 0; errors = 0; skipped = 0;
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
        // Check if already in Turso — SKIP if exists (Turso is source of truth for migrated users)
        const existing = await users.getUser(d.id);

        if (existing) {
          skipped++;
          continue; // User already migrated — skip entirely
        }

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
        migrated++;

        // Migrate schedule array — skip duplicates
        if (u.schedule && Array.isArray(u.schedule)) {
          const existingSchedule = await users.getScheduleItems(d.id) || [];
          for (const s of u.schedule) {
            const exists = existingSchedule.some(es => es.title === s.title && es.created_at === s.created_at);
            if (exists) {
              skipped++;
            } else {
              await users.addScheduleItem(d.id, s);
              migrated++;
            }
          }
        }
        // Migrate inbox array — skip duplicates
        if (u.inbox && Array.isArray(u.inbox)) {
          const existingInbox = await users.getInboxItems(d.id) || [];
          for (const item of u.inbox) {
            const exists = existingInbox.some(ei => ei.title === item.title && ei.created_at === item.created_at);
            if (exists) {
              skipped++;
            } else {
              await users.addInboxItem(d.id, item);
              migrated++;
            }
          }
        }
        // Migrate recentResults array — skip duplicates
        if (u.recentResults && Array.isArray(u.recentResults)) {
          const existingResults = await users.getRecentResults(d.id) || [];
          for (const r of u.recentResults) {
            const exists = existingResults.some(er => er.title === r.title && er.created_at === r.created_at);
            if (exists) {
              skipped++;
            } else {
              await users.addResult(d.id, r);
              migrated++;
            }
          }
        }
      } catch (e) { err(`User ${d.id}: ${e.message}`); }
    }
    log(`Users done: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
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
        // Check if course already exists in Turso — skip entire course + topics + questions
        const existingCourse = await courses.getCourse(d.id);
        if (existingCourse) {
          skipped++;
        } else {
          await courses.createCourse({
            id: d.id, title: c.title || '', level: c.level || '',
            totalTimeLimit: c.totalTimeLimit || 0, isStrict: !!c.isStrict,
            isMock: !!c.isMock, isCorrection: !!c.isCorrection
          });
          migrated++;
        }

        // Get topics subcollection
        const topicSnap = await getDocs(collection(db, 'unicourses', d.id, 'topics'));
        let sortOrder = 0;
        for (const tDoc of topicSnap.docs) {
          const t = tDoc.data();
          try {
            // Check if topic already exists in Turso
            const existingTopic = await courses.getTopic(tDoc.id);
            if (existingTopic) {
              skipped++;
              continue;
            }

            await courses.createTopic({
              id: tDoc.id, courseId: d.id, title: t.title || '',
              timeLimit: t.timeLimit || 0, isStrict: !!t.isStrict,
              isMock: !!t.isMock, isCorrection: !!t.isCorrection, sortOrder: sortOrder++
            });
            migrated++;

            // Migrate questions — skip duplicates by matching question text
            const existingQuestions = await courses.getQuestions(tDoc.id) || [];
            const questions = t.questions || [];
            for (let qi = 0; qi < questions.length; qi++) {
              const q = questions[qi];
              const questionText = (q.question || '').trim();
              const exists = existingQuestions.some(eq => (eq.question || '').trim() === questionText);
              if (exists) {
                skipped++;
              } else {
                const opts = q.options || ['', '', '', ''];
                await courses.createQuestion({
                  topicId: tDoc.id, courseId: d.id,
                  question: q.question || '', optionA: opts[0] || '', optionB: opts[1] || '',
                  optionC: opts[2] || '', optionD: opts[3] || '',
                  correctIndex: q.correctIndex ?? 0, explanation: q.explanation || '',
                  sortOrder: qi
                });
                migrated++;
              }
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
        // Check if quiz already exists in Turso — skip entire quiz + questions + attempts
        const existingQuiz = await quizzes.getQuiz(d.id);
        if (existingQuiz) {
          skipped++;
        } else {
          await quizzes.createQuiz({
            id: d.id, title: q.title || '', timeLimit: q.timeLimit || 0,
            maxAttempts: q.maxAttempts || 1
          });
          migrated++;
        }

        // Migrate questions — skip duplicates by matching text
        const existingQuestions = await quizzes.getQuizQuestions(d.id) || [];
        const allQuestions = q.questions || [];
        if (allQuestions.length > 0) {
          const existingTexts = existingQuestions.map(eq => (eq.question || '').trim());
          for (let qi = 0; qi < allQuestions.length; qi++) {
            const fq = allQuestions[qi];
            const questionText = (fq.question || '').trim();
            if (existingTexts.includes(questionText)) {
              skipped++;
            } else {
              await quizzes.createQuizQuestion(d.id, {
                question: fq.question || '',
                options: fq.options || ['','','',''],
                correctIndex: fq.correctIndex ?? 0,
                explanation: fq.explanation || '',
                sortOrder: qi
              });
              migrated++;
            }
          }
        }

        // Migrate attempts — skip duplicates by checking hasUserTakenQuiz
        const attempts = q.attempts || q.lastAttempts || {};
        for (const [uid, att] of Object.entries(attempts)) {
          try {
            const alreadyTaken = await quizzes.hasUserTakenQuiz(d.id, uid);
            if (alreadyTaken) {
              skipped++;
            } else {
              await quizzes.saveQuizAttempt(d.id, uid, {
                score: att.score || 0, correct: att.correct || 0,
                total: att.total || 0, timeTaken: att.timeTaken || 0,
                answers: att.answers || []
              });
              migrated++;
            }
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
        // Check if advice already exists in Turso
        const existingAdvice = await advices.getAdvice(d.id);
        if (existingAdvice) {
          skipped++;
          continue;
        }

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
        // Check if event already exists in Turso — skip event + registrations + keys
        const existingEvent = await events.getEvent(d.id);
        if (existingEvent) {
          skipped++;
        } else {
          await events.createEvent({
            id: d.id, title: ev.title || '', description: ev.description || '',
            availableSubjects: ev.availableSubjects || [],
            maxSubjects: ev.maxSubjects || 0,
            resultsReleased: !!ev.resultsReleased
          });
          migrated++;
        }

        // Migrate registrations from _data/registrations
        try {
          const regDoc = await getDoc(doc(db, 'subscription_events', d.id, '_data', 'registrations'));
          if (regDoc.exists()) {
            const students = regDoc.data().students || [];
            for (const s of students) {
              try {
                const alreadyRegistered = await events.getStudentRegistration(d.id, s.uid);
                if (alreadyRegistered) {
                  skipped++;
                } else {
                  await events.registerStudent(d.id, {
                    uid: s.uid, displayName: s.displayName || '',
                    email: s.email || '', subjects: s.subjects || []
                  });
                  migrated++;
                }
              } catch (er) { /* skip individual reg errors */ }
            }
          }
        } catch (er) { /* skip subcollection errors */ }

        // Migrate keys
        try {
          const keySnap = await getDocs(collection(db, 'subscription_events', d.id, 'keys'));
          const existingKeys = await events.getEventKeys(d.id) || [];
          for (const kDoc of keySnap.docs) {
            try {
              const keyExists = existingKeys.some(ek => ek.id === kDoc.id);
              if (keyExists) {
                skipped++;
              } else {
                await events.createEventKey(d.id, kDoc.id);
                const k = kDoc.data();
                if (k.usedBy) {
                  await events.useKey(d.id, kDoc.id, k.usedBy);
                }
                migrated++;
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
        // Check if mock already exists in Turso — skip entire mock + attempts
        const existingMock = await mocks.getMock(d.id);
        if (existingMock) {
          skipped++;
        } else {
          await mocks.createMock({
            id: d.id, eventId: m.eventId || '', subject: m.subject || '',
            title: m.title || '', timeLimit: m.timeLimit || 0
          });
          if (m.questions) {
            await mocks.updateMockQuestions(d.id, m.questions);
          }
          migrated++;
        }

        // Migrate attempts subcollection — skip duplicates by uid
        try {
          const attSnap = await getDocs(collection(db, 'mock_exams', d.id, 'attempts'));
          const existingAttempts = await mocks.getMockAttempts(d.id) || [];
          for (const aDoc of attSnap.docs) {
            const a = aDoc.data();
            try {
              const attemptUid = a.uid || aDoc.id;
              const attemptExists = existingAttempts.some(ea => ea.uid === attemptUid);
              if (attemptExists) {
                skipped++;
              } else {
                await mocks.saveMockAttempt(d.id, {
                  uid: attemptUid, displayName: a.displayName || '',
                  email: a.email || '', score: a.score || 0, correct: a.correct || 0,
                  total: a.totalQuestions || a.total || 0, timeTaken: a.timeTaken || 0,
                  answers: a.answers || [], browserAgent: a.browserAgent || '',
                  platform: a.platform || '', screenResolution: a.screenResolution || ''
                });
                migrated++;
              }
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
    const existing = await notifications.getBroadcastNotifications(1);
    if (existing && existing.length > 0) {
      log('Broadcast notifications already exist — skipping');
      skipped++;
    } else {
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
    }
  } catch (e) { err(`Notifications: ${e.message}`); }

  // STEP 8: Migrate Broadcast Schedules
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating schedules...`);
  try {
    const existing = await schedules.getBroadcastSchedules(1);
    if (existing && existing.length > 0) {
      log('Broadcast schedules already exist — skipping');
      skipped++;
    } else {
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
    }
  } catch (e) { err(`Schedules: ${e.message}`); }

  // STEP 9: Migrate Counters + Admin Panel
  step++;
  onProgress?.(`Step ${step}/${totalSteps}: Migrating counters...`);
  try {
    // Counter — skip if already set
    const counterVal = await counters.getCounter('totalUsers');
    if (counterVal && counterVal > 0) {
      log('Counter totalUsers already exists — skipping');
      skipped++;
    } else {
      const counterSnap = await getDoc(doc(db, '_stats', 'counters'));
      if (counterSnap.exists()) {
        const val = counterSnap.data().totalUsers || 0;
        await counters.setCounter('totalUsers', val);
        migrated++;
        log(`Counter totalUsers = ${val}`);
      }
    }

    // Admin panel — skip if already has data
    const adminData = await admin.getAdminPanel();
    if (adminData && Object.keys(adminData).length > 0) {
      log('Admin panel data already exists — skipping');
      skipped++;
    } else {
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
        migrated++;
      }
    }
  } catch (e) { err(`Counters/admin: ${e.message}`); }

  const result = { migrated, errors, skipped };
  log(`Migration complete: ${result.migrated} migrated, ${result.skipped} skipped, ${result.errors} errors`);
  return result;
}
