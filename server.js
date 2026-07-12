const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// נתיב קבלת הנתונים ממודול ה-API של ימות המשיח
app.get('/api/yemot', (req, res) => {
    const callData = req.query; 
    
    // 1. חסימת דיווח כפול: התעלמות מקריאות שנשלחות אוטומטית בניתוק שיחה
    if (callData.hangup === 'yes') {
        return res.send('');
    }

    // 2. אם הבחור עדיין לא הקיש את התשובה שלו (חסר פרמטר vote), השרת מבקש אותה
    if (!callData.vote) {
        // שימוש בפקודת read לבקשת נתונים מהמשתמש ושליחתם בחזרה לשרת
        return res.send('read=t-אנא הקישו את מספר התשובה שלכם=vote,no,1,1,7,Number,yes,no,*/');
    }

    // 3. יש לנו הצבעה! השרת קולט את הספרה שהוקשה ומשדר למסך באולם
    console.log('New vote received from:', callData.ApiPhone, 'Vote:', callData.vote);
    io.emit('new_vote', callData);

    // 4. סיום התהליך: השמעת תודה
    res.send('id_list_message=t-תודה על ההצבעה.&'); 
});

// ניהול החיבור הרציף מול מסך האווירה
io.on('connection', (socket) => {
    console.log('Screen connected:', socket.id);
    
    socket.on('update_judge_score', (data) => {
        io.emit('live_judge_update', data);
    });

    socket.on('disconnect', () => {
        console.log('Screen disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});