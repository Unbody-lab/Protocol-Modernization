const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// --- Настройки мира ---
const WORLD_W = 2600, WORLD_H = 2000;
let players = {};
let rocks = [];

// Генерация карты (такая же, как в клиенте)
function genWorld() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    rocks = [];
    for (let i = 0; i < 62; i++) {
        for (let att = 0; att < 60; att++) {
            const r = 34 + rnd(0, 66);
            const x = 130 + rnd(0, WORLD_W - 260);
            const y = 130 + rnd(0, WORLD_H - 260);
            let ok = true;
            for (const o of rocks) {
                if (Math.hypot(o.x - x, o.y - y) < o.r + r + 62) { ok = false; break; }
            }
            if (ok) { rocks.push({ x, y, r }); break; }
        }
    }
}
genWorld();

// Поиск свободного места для спавна
function findSpawnPoint() {
    for (let i = 0; i < 400; i++) {
        const x = 150 + Math.random() * (WORLD_W - 300);
        const y = 150 + Math.random() * (WORLD_H - 300);
        let ok = true;
        for (const r of rocks) {
            if (Math.hypot(r.x - x, r.y - y) < r.r + 80) { ok = false; break; }
        }
        if (ok) return { x, y };
    }
    return { x: WORLD_W / 2, y: WORLD_H / 2 };
}

// --- ФИЗИКА ПУЛЬ НА СЕРВЕРЕ (ДЛЯ УЛЬТЫ ЛЁХИ) ---
let serverBullets = [];

setInterval(() => {
    const dt = 1/60;
    for (let i = serverBullets.length - 1; i >= 0; i--) {
        const b = serverBullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;

        let exploded = false;

        // Столкновение большой бомбы с врагом
        if (b.type === 'big_bomb') {
            for (let id in players) {
                const p = players[id];
                if (!p.alive || id === b.owner) continue;
                if (Math.hypot(b.x - p.x, b.y - p.y) < 19 + b.r) {
                    exploded = true;
                    break;
                }
            }
        }

        // Столкновение с камнями
        if (!exploded) {
            for (const r of rocks) {
                if (Math.hypot(b.x - r.x, b.y - r.y) < r.r + b.r) {
                    exploded = true;
                    break;
                }
            }
        }

        if (exploded || b.life <= 0) {
            // Если взорвалась большая бомба
            if (b.type === 'big_bomb') {
                io.emit('bombExploded', { x: b.x, y: b.y, owner: b.owner });
                
                // Наносим урон всем в радиусе
                for (let id in players) {
                    const p = players[id];
                    if (p.alive && id !== b.owner && Math.hypot(b.x - p.x, b.y - p.y) < 150) {
                        p.hp -= 50;
                        if (players[b.owner]) players[b.owner].ult = Math.min(100, players[b.owner].ult + 25);
                        if (p.hp <= 0) {
                            p.hp = 0; p.alive = false; p.respawnTimer = 3;
                            if (players[b.owner]) players[b.owner].score++;
                        }
                    }
                }
                io.emit('updateHealth', players);

                // Создаем осколки
                for (let j = 0; j < 8; j++) {
                    const ang = (j / 8) * Math.PI * 2;
                    serverBullets.push({
                        x: b.x, y: b.y,
                        vx: Math.cos(ang) * 600, vy: Math.sin(ang) * 600,
                        r: 7, dmg: 10, life: 1.2, type: 'bomb', poison: true, owner: b.owner
                    });
                }
            }
            serverBullets.splice(i, 1);
        }
    }
}, 1000 / 60);

io.on('connection', (socket) => {
    const spawn = findSpawnPoint();
    
    // Создаем игрока (по умолчанию Витя)
    players[socket.id] = {
        id: socket.id,
        x: spawn.x, y: spawn.y,
        hp: 100, maxHp: 100, score: 0, aim: 0, alive: true, respawnTimer: 0, 
        ult: 0, ultActive: false, ultTime: 0, walkPhase: 0,
        name: 'Игрок ' + Math.floor(Math.random() * 90 + 10),
        color: `hsl(${Math.random() * 360}, 100%, 50%)`,
        colorLight: `hsl(${Math.random() * 360}, 100%, 80%)`,
        type: 'Vitya' 
    };

    socket.emit('init', { players, rocks, myId: socket.id });
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Выбор персонажа
    socket.on('selectHero', (heroType) => {
        if (players[socket.id]) {
            players[socket.id].type = heroType;
            socket.broadcast.emit('updatePlayerType', { id: socket.id, type: heroType });
        }
    });

    // Движение
    socket.on('move', (data) => {
        const p = players[socket.id];
        if (p && p.alive) {
            p.x = data.x; p.y = data.y; p.aim = data.aim; p.walkPhase = data.walkPhase;
            socket.broadcast.volatile.emit('playerMoved', { id: socket.id, x: data.x, y: data.y, aim: data.aim, walkPhase: data.walkPhase });
        }
    });

    // Стрельба
    socket.on('shoot', (bulletData) => {
        socket.broadcast.volatile.emit('newBullet', { owner: socket.id, bullet: bulletData });
        // Добавляем пулю на сервер для физики (если это бомба)
        if (bulletData.type === 'bomb' || bulletData.type === 'big_bomb') {
            serverBullets.push({ ...bulletData, owner: socket.id });
        }
    });

    // Урон
    socket.on('hitPlayer', (data) => {
        const target = players[data.target];
        if (target && target.alive) {
            target.hp -= data.damage;
            if (players[socket.id] && !players[socket.id].ultActive) {
                players[socket.id].ult = Math.min(100, players[socket.id].ult + data.damage * 0.5);
            }
            if (target.hp <= 0) {
                target.hp = 0; target.alive = false; target.respawnTimer = 3; target.ultActive = false;
                if (players[socket.id]) players[socket.id].score++;
            }
            io.emit('updateHealth', players);
        }
    });

    // Ульта
    socket.on('ult', (data) => {
        const p = players[socket.id];
        if (p) {
            p.ultActive = data.active;
            socket.broadcast.emit('playerUlt', { id: socket.id, active: data.active });
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// Порт для Render
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
