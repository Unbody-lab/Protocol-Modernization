const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    // В режиме тренировки сервер просто принимает подключение и ничего не делает.
    // Если кто-то зайдет по сети, сервер будет работать как раньше.
    socket.emit('init', { players: {}, rocks: [], myId: socket.id });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
