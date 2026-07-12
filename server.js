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

// --- משתני ניהול מצב השרת ---
let isVotingOpen = false;
let currentAllowedKeys = '1.2.3.4'; // ברירת מחדל ל-4 מתמודדים
let votersList = {}; // מאגר התלמידים מתוך האקסל
let currentRoundVotes = new Set(); // רשימת מספרי הטלפון שכבר הצביעו בסיבוב הנוכחי
let totalVotesCount = 0; // מונה ההצבעות נטו למסך

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
        // המערכת תאפשר רק את המקשים שהגדרת בפאנל (למשל 1.2.3.4.5)
        return res.send(`read=t-ההצבעה פתוחה, אנא הקישו את בחירתכם=vote,no,1,1,7,Number,yes,no,*/,${currentAllowedKeys}`);
    }

    // 5. קליטת ההצבעה ושמירתה
    currentRoundVotes.add(phone);
    totalVotesCount++;

    // שליפת פרטי הבחור מהאקסל (או סימונו כחריג אם אינו קיים)
    const voterInfo = votersList[phone] || { name: 'לא רשום', group: 'חריג' };
    
    // שידור המספר המוחלט בלבד למסך האווירה
    io.emit('screen_vote_count_update', { count: totalVotesCount });
    
    // שידור הנתונים המלאים (כולל שיעור ושם) אך ורק לפאנל הניהול שלך
    io.emit('admin_vote_details', { 
        phone: phone, 
        vote: callData.vote, 
        info: voterInfo 
    });

    // סיום השיחה בצורה חלקה
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
                // תיקון פורמט למספרים שמתחילים ב-972
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

// --- ניהול WebSockets (זמן אמת) ---
io.on('connection', (socket) => {
    
    // קבלת פקודות מפאנל הניהול
    socket.on('admin_set_status', (data) => {
        isVotingOpen = data.isOpen;
        if (data.allowedKeys) currentAllowedKeys = data.allowedKeys;
        
        // איפוס הסיבוב לקראת סיבוב חדש
        if (isVotingOpen && data.newRound) {
            currentRoundVotes.clear();
            totalVotesCount = 0;
            io.emit('screen_vote_count_update', { count: totalVotesCount });
        }
        io.emit('admin_status_update', { isOpen: isVotingOpen });
    });

    // הוספת חריגים ידנית
    socket.on('admin_add_single_voter', (data) => {
        if (data.phone) {
            votersList[data.phone] = { name: data.name, group: data.group };
        }
    });

    // שליטה בטיימר ספירה לאחור
    let timerInterval;
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