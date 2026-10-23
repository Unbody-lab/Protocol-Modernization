const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const WORLD_W = 2600, WORLD_H = 2000;
let players = {};
let rocks = [];
let bullets = [];

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

io.on('connection', (socket) => {
    const spawn = findSpawnPoint();
    players[socket.id] = {
        id: socket.id,
        x: spawn.x, y: spawn.y,
        hp: 100,
        score: 0,
        aim: 0,
        alive: true,
        respawnTimer: 0,
        ult: 0,
        ultActive: false,
        ultTime: 0,
        walkPhase: 0,
        name: 'Игрок ' + Math.floor(Math.random() * 90 + 10),
        color: `hsl(${Math.random() * 360}, 100%, 50%)`,
        colorLight: `hsl(${Math.random() * 360}, 100%, 80%)`
    };

    socket.emit('init', { players, rocks, myId: socket.id });
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('move', (data) => {
        const p = players[socket.id];
        if (p && p.alive) {
            p.x = data.x;
            p.y = data.y;
            p.aim = data.aim;
            p.walkPhase = data.walkPhase;
            socket.broadcast.volatile.emit('playerMoved', { id: socket.id, x: data.x, y: data.y, aim: data.aim, walkPhase: data.walkPhase });
        }
    });

    socket.on('shoot', (bulletData) => {
        const p = players[socket.id];
        if (!p || !p.alive) return;
        bullets.push({ ...bulletData, owner: socket.id, life: 0.9 });
    });

    // БЕЗОПАСНЫЙ УРОН
    socket.on('hitPlayer', (data) => {
        const target = players[data.target];
        const source = players[socket.id];
        
        // Защита от краша: проверяем, что оба игрока живы и существуют
        if (!target || !target.alive || !source || !source.alive) return;

        target.hp -= data.damage;
        if (source.ultActive === false) source.ult = Math.min(100, source.ult + data.damage * 0.5);

        if (target.hp <= 0) {
            target.hp = 0;
            target.alive = false;
            target.respawnTimer = 3;
            target.ultActive = false;
            source.score += 1;
            if (source.score >= 8) io.emit('gameOver', { winnerName: source.name });
        }
        io.emit('updateHealth', players);
    });

    socket.on('ult', (data) => {
        const p = players[socket.id];
        if (p && p.ult >= 100 && !p.ultActive) {
            p.ult = 0; p.ultActive = true; p.ultTime = 3.0;
            io.emit('playerUlt', { id: socket.id, active: true });
        } else if (p && !data.active) {
            p.ultActive = false;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// Оптимизированный цикл сервера
setInterval(() => {
    const dt = 1 / 60;
    
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
        let dead = b.life <= 0;

        if (!dead) {
            for (const r of rocks) {
                if (Math.hypot(b.x - r.x, b.y - r.y) < r.r + b.r) { dead = true; break; }
            }
        }
        if (!dead) {
            for (const id in players) {
                const p = players[id];
                if (!p.alive || id === b.owner) continue;
                if (Math.hypot(b.x - p.x, b.y - p.y) < 19 + b.r) {
                    const source = players[b.owner];
                    if (source) {
                        p.hp -= b.dmg || 16;
                        if (!source.ultActive) source.ult = Math.min(100, source.ult + 8);
                        if (p.hp <= 0) {
                            p.hp = 0; p.alive = false; p.respawnTimer = 3;
                            source.score += 1;
                        }
                        io.emit('updateHealth', players);
                    }
                    dead = true; break;
                }
            }
        }
        if (dead) bullets.splice(i, 1);
    }

    let changed = false;
    for (const id in players) {
        const p = players[id];
        if (p.ultActive) {
            p.ultTime -= dt;
            if (p.ultTime <= 0) { p.ultActive = false; p.ultTime = 0; changed = true; }
        }
        if (!p.alive) {
            p.respawnTimer -= dt;
            if (p.respawnTimer <= 0) {
                const spawn = findSpawnPoint();
                p.x = spawn.x; p.y = spawn.y; p.hp = 100; p.alive = true;
                changed = true;
            }
        }
    }
    if (changed) io.emit('updateHealth', players);
    
    if (bullets.length > 0) {
        io.volatile.emit('bullets', bullets);
    }
}, 1000 / 60);

const PORT = process.env.PORT || 10000; // Render выдает порт 10000
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
