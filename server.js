const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =========================================================
//  "הראש הקליבער" - מבנה התוכנית:
//  חלק א': שלב הבתים - 5 סיבובים, 8 בחורים בכל סיבוב, עולה אחד מכל סיבוב
//  גלגל ההצלה: הנופל עם הניקוד המשוקלל הגבוה ביותר מחלק א' חוזר (עולה שישי)
//  חלק ב': חצי הגמר - 6 בחורים, שאלה פתוחה, 3 עולים לגמר
//  חלק ג': הגמר הגדול - הכספת - 3 בחורים, הראשון שפותח את הכספת מנצח
// =========================================================

// --- משתני ניהול מצב הצבעה ---
let isVotingOpen = false;
let currentAllowedKeys = '1.2.3.4';
let votersList = {}; // מאגר התלמידים מתוך האקסל
let currentRoundVotes = new Set(); // מספרי טלפון שכבר הצביעו בסיבוב הנוכחי
let totalVotesCount = 0; // מונה ההצבעות נטו למסך
let currentRoundTally = {}; // ספירת קולות לפי מקש, למשל { '1': 12, '2': 7 }

// --- שלבי התוכנית ---
const STAGE_TITLES = {
    houses: 'שלב הבתים',
    rescue: 'גלגל ההצלה',
    semi: 'חצי הגמר - השאלה הפתוחה',
    final: 'הגמר הגדול - הכספת'
};
const TOTAL_HOUSE_ROUNDS = 5;
let currentStage = 'houses';
let currentRound = 1; // סיבוב נוכחי בשלב הבתים (1-5)

function getScreenTitle() {
    if (currentStage === 'houses') {
        return `שלב הבתים • סיבוב ${currentRound} מתוך ${TOTAL_HOUSE_ROUNDS}`;
    }
    return STAGE_TITLES[currentStage];
}

// --- מאגר המתמודדים ---
// סטטוסים: 'ממתין' | 'נפל' | 'חצי גמר' | 'גמר' | 'אלוף'
// ההיסטוריה של כל מתמודד נשמרת עבור גלגל ההצלה
let contestants = [];
let nextContestantId = 1;
let roundHistory = []; // תיעוד מלא של כל סיבוב שהסתיים

function getContestant(id) {
    return contestants.find(c => c.id === Number(id));
}

function broadcastContestants() {
    io.emit('contestants_update', contestants);
}

// הגדרת קליטת קבצי אקסל מפאנל הניהול
const upload = multer({ dest: 'uploads/' });

// --- נתיב ה-API עבור ימות המשיח ---
app.get('/api/yemot', (req, res) => {
    const callData = req.query;
    const phone = callData.ApiPhone;

    // 1. התעלמות מקריאות אוטומטיות בניתוק שיחה כדי למנוע כפילויות
    if (callData.hangup === 'yes') {
        return res.send('');
    }

    // 2. חסימת חיוגים כשפאנל הניהול סגור להצבעות
    if (!isVotingOpen) {
        return res.send('id_list_message=t-ההצבעה סגורה כעת.&go_to_folder=hangup');
    }

    // 3. חסימת מי שמנסה להצביע שוב באותו סיבוב
    if (currentRoundVotes.has(phone)) {
        return res.send('id_list_message=t-כבר הצבעתם בסיבוב זה.&go_to_folder=hangup');
    }

    // 4. אם הבחור עדיין לא הקיש את התשובה (מבקש את ההקשה)
    if (!callData.vote) {
        return res.send(`read=t-ההצבעה פתוחה, אנא הקישו את בחירתכם=vote,no,1,1,7,Number,yes,no,*/,${currentAllowedKeys}`);
    }

    // 5. קליטת ההצבעה ושמירתה
    currentRoundVotes.add(phone);
    totalVotesCount++;
    currentRoundTally[callData.vote] = (currentRoundTally[callData.vote] || 0) + 1;

    // שליפת פרטי הבחור מהאקסל (או סימונו כחריג אם אינו קיים)
    const voterInfo = votersList[phone] || { name: 'לא רשום', group: 'חריג' };

    // שידור המספר המוחלט בלבד למסך האווירה
    io.emit('screen_vote_count_update', { count: totalVotesCount });

    // שידור הנתונים המלאים אך ורק לפאנל הניהול
    io.emit('admin_vote_details', {
        phone: phone,
        vote: callData.vote,
        info: voterInfo
    });

    res.send('id_list_message=t-תודה על ההצבעה.&go_to_folder=hangup');
});

// --- נתיב להעלאת קובץ האקסל מפאנל הניהול ---
app.post('/api/upload_voters', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);

        let count = 0;
        data.forEach(row => {
            const phone = String(row['טלפון'] || row['phone'] || '').replace(/\D/g, '');
            if (phone) {
                const formattedPhone = phone.startsWith('972') ? '0' + phone.substring(3) : phone;
                votersList[formattedPhone] = {
                    name: `${row['שם פרטי'] || ''} ${row['שם משפחה'] || ''}`.trim(),
                    group: row['שיעור'] || 'כללי'
                };
                count++;
            }
        });
        res.send({ success: true, count: count });
    } catch (error) {
        res.status(500).send('Error parsing Excel file.');
    }
});

// טיימר ברמת המודול - מונע יצירת טיימרים כפולים כשמחוברים כמה מסכים במקביל
let timerInterval = null;

// --- ניהול WebSockets (זמן אמת) ---
io.on('connection', (socket) => {

    // סנכרון מצב מלא לכל מסך שמתחבר (פאנל ניהול או מסך קהל)
    socket.emit('init_state', {
        stage: currentStage,
        round: currentRound,
        stageTitle: STAGE_TITLES[currentStage],
        screenTitle: getScreenTitle(),
        contestants: contestants,
        isOpen: isVotingOpen,
        count: totalVotesCount
    });

    // פתיחה/סגירה של הצבעת הקהל (קליקרים)
    socket.on('admin_set_status', (data) => {
        isVotingOpen = data.isOpen;
        if (data.allowedKeys) currentAllowedKeys = data.allowedKeys;

        // איפוס הסיבוב לקראת הצבעה חדשה
        if (isVotingOpen && data.newRound) {
            currentRoundVotes.clear();
            totalVotesCount = 0;
            currentRoundTally = {};
            io.emit('screen_vote_count_update', { count: totalVotesCount });
        }
        io.emit('admin_status_update', { isOpen: isVotingOpen });

        // אנימציית נעילה במסך הקהל בסגירת הצבעה, והסרתה בפתיחה
        io.emit(isVotingOpen ? 'screen_voting_unlocked' : 'screen_voting_locked');
    });

    // מעבר שלב/סיבוב בתוכנית - מעדכן גם את כותרת מסך הקהל
    socket.on('admin_set_stage', (data) => {
        if (!STAGE_TITLES[data.stage]) return;
        currentStage = data.stage;
        if (data.round) {
            currentRound = Math.min(Math.max(Number(data.round), 1), TOTAL_HOUSE_ROUNDS);
        }
        io.emit('stage_update', {
            stage: currentStage,
            round: currentRound,
            title: STAGE_TITLES[currentStage],
            screenTitle: getScreenTitle()
        });
    });

    // --- ניהול מאגר המתמודדים ---
    socket.on('admin_add_contestant', (data) => {
        if (!data.name) return;
        contestants.push({
            id: nextContestantId++,
            name: String(data.name).trim(),
            group: data.group || 'כללי',
            status: 'ממתין',
            history: [] // { stage, round, votes, audiencePoints, judgePoints, finalScore }
        });
        broadcastContestants();
    });

    socket.on('admin_update_contestant', (data) => {
        const c = getContestant(data.id);
        if (!c) return;
        if (data.name !== undefined) c.name = data.name;
        if (data.group !== undefined) c.group = data.group;
        if (data.status !== undefined) c.status = data.status;
        broadcastContestants();
    });

    socket.on('admin_delete_contestant', (data) => {
        contestants = contestants.filter(c => c.id !== Number(data.id));
        broadcastContestants();
    });

    // =========================================================
    //  שלב הבתים - שקלול סיבוב והכרזת העולה
    //  entries: [{ key, contestantId }] - עד 4 הבחורים שעברו את מבחן התוצאה
    //  judgePicks: [contestantId x4] - כל שופט נותן את ה-10% שלו לבחור אחד
    //  ניקוד סופי (מתוך 100) = חלק יחסי מקולות הקהל x60 + מספר שופטים x10
    // =========================================================
    socket.on('admin_finalize_houses', (data) => {
        const entries = data.entries || [];
        const judgePicks = (data.judgePicks || []).map(Number);
        const round = Number(data.round) || currentRound;
        const totalVotes = entries.reduce((sum, e) => sum + (currentRoundTally[e.key] || 0), 0);

        const results = entries.map(e => {
            const votes = currentRoundTally[e.key] || 0;
            const audiencePoints = totalVotes > 0
                ? Number((votes / totalVotes * 60).toFixed(1))
                : 0;
            const judgeCount = judgePicks.filter(p => p === Number(e.contestantId)).length;
            const judgePoints = judgeCount * 10;
            const finalScore = Number((audiencePoints + judgePoints).toFixed(1));

            return {
                contestantId: Number(e.contestantId),
                name: (getContestant(e.contestantId) || {}).name || 'לא ידוע',
                votes, audiencePoints, judgePoints, finalScore
            };
        });

        results.sort((a, b) => b.finalScore - a.finalScore);

        // העולה לחצי הגמר - המקום הראשון. השאר נופלים והניקוד שלהם נשמר לגלגל ההצלה
        results.forEach((r, i) => {
            const c = getContestant(r.contestantId);
            if (!c) return;
            c.history.push({
                stage: 'houses', round,
                votes: r.votes,
                audiencePoints: r.audiencePoints,
                judgePoints: r.judgePoints,
                finalScore: r.finalScore
            });
            c.status = (i === 0) ? 'חצי גמר' : 'נפל';
            r.outcome = (i === 0) ? 'עולה לחצי הגמר!' : 'נפל';
        });

        roundHistory.push({ stage: 'houses', round, results });
        io.emit('round_results', { stage: 'houses', round, results });

        // הכרזה דרמטית על מסך הקהל - שם העולה בלבד, ללא חשיפת ניקוד/תוצאות
        if (results.length > 0) {
            io.emit('screen_announcement', {
                title: 'העולה לחצי הגמר',
                name: results[0].name,
                subtitle: `סיבוב ${round}`
            });
        }
        broadcastContestants();
    });

    // =========================================================
    //  גלגל ההצלה - העולה השישי
    //  סורק את כל מי שנפל בשלב ההצבעה בחלק א' ומכריז על
    //  בעל הניקוד המשוקלל הגבוה ביותר - הוא חוזר לבמה!
    // =========================================================
    socket.on('admin_calc_rescue', () => {
        const fallen = contestants.filter(c =>
            c.status === 'נפל' && c.history.some(h => h.stage === 'houses')
        );
        if (fallen.length === 0) {
            socket.emit('rescue_winner', { winner: null });
            return;
        }

        let winner = null;
        let bestScore = -1;
        fallen.forEach(c => {
            const best = Math.max(...c.history.filter(h => h.stage === 'houses').map(h => h.finalScore));
            if (best > bestScore) {
                bestScore = best;
                winner = c;
            }
        });

        winner.status = 'חצי גמר';
        io.emit('rescue_winner', { winner: { id: winner.id, name: winner.name, score: bestScore } });
        io.emit('screen_announcement', {
            title: 'גלגל ההצלה - חוזר לבמה!',
            name: winner.name,
            subtitle: 'העולה השישי לחצי הגמר'
        });
        broadcastContestants();
    });

    // =========================================================
    //  חצי הגמר - השאלה הפתוחה
    //  entries: [{ key, contestantId, judgeScore }] - 6 בחורים
    //  שופטים נותנים ציון 1-10, הקהל מוסיף את הניקוד שלו
    //  ניקוד סופי (מתוך 100) = חלק יחסי מקולות הקהל x60 + ציון שופטים x4
    //  3 בעלי הניקוד הנמוך מודחים, 3 עולים לגמר
    // =========================================================
    socket.on('admin_finalize_semi', (data) => {
        const entries = data.entries || [];
        const totalVotes = entries.reduce((sum, e) => sum + (currentRoundTally[e.key] || 0), 0);

        const results = entries.map(e => {
            const votes = currentRoundTally[e.key] || 0;
            const audiencePoints = totalVotes > 0
                ? Number((votes / totalVotes * 60).toFixed(1))
                : 0;
            const judgeScore = Number(e.judgeScore) || 0;
            const judgePoints = Number((judgeScore * 4).toFixed(1));
            const finalScore = Number((audiencePoints + judgePoints).toFixed(1));

            return {
                contestantId: Number(e.contestantId),
                name: (getContestant(e.contestantId) || {}).name || 'לא ידוע',
                votes, audiencePoints, judgePoints, finalScore
            };
        });

        results.sort((a, b) => b.finalScore - a.finalScore);

        results.forEach((r, i) => {
            const c = getContestant(r.contestantId);
            if (!c) return;
            c.history.push({
                stage: 'semi', round: 0,
                votes: r.votes,
                audiencePoints: r.audiencePoints,
                judgePoints: r.judgePoints,
                finalScore: r.finalScore
            });
            // 3 הראשונים עולים לגמר, השאר מודחים
            c.status = (i < 3) ? 'גמר' : 'נפל';
            r.outcome = (i < 3) ? 'עולה לגמר!' : 'מודח';
        });

        roundHistory.push({ stage: 'semi', results });
        io.emit('round_results', { stage: 'semi', results });
        broadcastContestants();
    });

    // =========================================================
    //  הגמר הגדול - הכספת
    //  מי שמקיש קוד שגוי נפסל; מי שפותח את הכספת מוכתר לאלוף
    // =========================================================
    socket.on('admin_set_champion', (data) => {
        const c = getContestant(data.contestantId);
        if (!c) return;
        c.status = 'אלוף';
        io.emit('champion_announced', { id: c.id, name: c.name });
        io.emit('screen_announcement', {
            title: 'הכספת נפתחה!',
            name: c.name,
            subtitle: 'הראש הקליבער של הישיבה',
            isChampion: true
        });
        broadcastContestants();
    });

    // ניקוי הכרזות ממסך הקהל
    socket.on('admin_clear_announcement', () => {
        io.emit('screen_announcement_clear');
    });

    // איפוס הצבעת קהל: מחיקת קולות הסיבוב הנוכחי בלבד.
    // ההיסטוריה של המתמודדים נשמרת עבור גלגל ההצלה
    socket.on('admin_reset_round', () => {
        currentRoundVotes.clear();
        totalVotesCount = 0;
        currentRoundTally = {};
        io.emit('screen_vote_count_update', { count: 0 });
        io.emit('round_was_reset');
    });

    // הוספת חריגים ידנית למאגר המצביעים
    socket.on('admin_add_single_voter', (data) => {
        if (data.phone) {
            votersList[data.phone] = { name: data.name, group: data.group };
        }
    });

    // חיווי חי של הצבעת השופטים למסך הקהל - כמה שופטים כבר הזין המנחה (בלי לחשוף את הבחירה)
    socket.on('admin_judge_progress', (data) => {
        io.emit('screen_judge_progress', { count: Number(data.count) || 0, total: Number(data.total) || 4 });
    });

    // שליטה בטיימר ספירה לאחור (60 שניות בבתים, 2 דקות בחצי הגמר)
    socket.on('admin_start_timer', (data) => {
        let seconds = data.seconds;
        clearInterval(timerInterval);
        io.emit('screen_timer_update', { seconds: seconds });

        timerInterval = setInterval(() => {
            seconds--;
            io.emit('screen_timer_update', { seconds: seconds });
            if (seconds <= 0) {
                clearInterval(timerInterval);
            }
        }, 1000);
    });

    socket.on('admin_stop_timer', () => {
        clearInterval(timerInterval);
        io.emit('screen_timer_stop');
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
