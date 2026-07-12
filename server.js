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
    const callData = req.query; // כל הפרמטרים שימות המשיח שולחים (מזהה טלפון, מקש שהוקש וכו')
    
    console.log('New vote received:', callData);

    // שידור הנתונים מיד ל-WebSocket כדי שהמסך באולם יתעדכן באותה שנייה
    io.emit('new_vote', callData);

    // החזרת פקודת סיום לימות המשיח כדי לנתק את השיחה או להשמיע הודעה
    res.send('id_list_message=t-תודה על ההצבעה.&'); 
});

// ניהול החיבור הרציף מול מסך האווירה
io.on('connection', (socket) => {
    console.log('Screen connected:', socket.id);
    
    // קליטת עדכון ניקוד שופטים מפאנל הניהול והעברתו למסך
    socket.on('update_judge_score', (data) => {
        io.emit('live_judge_update', data);
    });

    socket.on('disconnect', () => {
        console.log('Screen disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});