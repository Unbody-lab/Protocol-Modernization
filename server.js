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
let bots = []; // Для тренировки

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

const HEROES = {
    VITYA: { name: 'Витя', color: '#3fa9f5', colorLight: '#a8e0ff' },
    LESHA: { name: 'Лёха', color: '#ff7a4d', colorLight: '#ffb99b' }
};

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
        hero: 'VITYA',
        ...HEROES.VITYA
    };

    socket.emit('init', { players, rocks, myId: socket.id });
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('setHero', (hero) => {
        if (players[socket.id] && HEROES[hero]) {
            players[socket.id].hero = hero;
            players[socket.id].name = HEROES[hero].name;
            players[socket.id].color = HEROES[hero].color;
            players[socket.id].colorLight = HEROES[hero].colorLight;
            io.emit('updateHealth', players);
        }
    });

    socket.on('move', (data) => {
        const p = players[socket.id];
        if (p && p.alive) {
            p.x = data.x; p.y = data.y; p.aim = data.aim; p.walkPhase = data.walkPhase;
            socket.broadcast.volatile.emit('playerMoved', { id: socket.id, x: data.x, y: data.y, aim: data.aim, walkPhase: data.walkPhase });
        }
    });

    socket.on('shoot', (bulletData) => {
        const p = players[socket.id];
        if (!p || !p.alive) return;
        bullets.push({ ...bulletData, owner: socket.id, life: 0.9 });
    });

    socket.on('hitPlayer', (data) => {
        const target = players[data.target];
        const source = players[socket.id];
        if (!target || !target.alive || !source || !source.alive) return;

        target.hp -= data.damage;
        if (data.poison) target.poison = 2.0; // Время отравления
        if (!source.ultActive) source.ult = Math.min(100, source.ult + data.damage * 0.5);

        if (target.hp <= 0) {
            target.hp = 0; target.alive = false; target.respawnTimer = 3;
            target.ultActive = false; source.score += 1;
            if (source.score >= 8) io.emit('gameOver', { winnerName: source.name });
        }
        io.emit('updateHealth', players);
    });

    socket.on('ult', (data) => {
        const p = players[socket.id];
        if (p && p.ult >= 100 && !p.ultActive) {
            p.ult = 0; p.ultActive = true; p.ultTime = p.hero === 'LESHA' ? 0 : 3.0;
            io.emit('playerUlt', { id: socket.id, active: true, hero: p.hero, x: p.x, y: p.y, aim: p.aim });
        }
    });

    // ТРЕНИРОВКА
    socket.on('startTraining', () => {
        // Спавн ботов
        if (bots.length === 0) {
            for (let i = 0; i < 3; i++) {
                const botSpawn = findSpawnPoint();
                const isLesha = Math.random() > 0.5;
                bots.push({
                    id: 'bot_' + i,
                    x: botSpawn.x, y: botSpawn.y,
                    hp: 100, alive: true, respawnTimer: 0, aim: 0,
                    hero: isLesha ? 'LESHA' : 'VITYA',
                    ...(isLesha ? HEROES.LESHA : HEROES.VITYA),
                    isBot: true, botTimer: 0, target: null
                });
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// Безопасный игровой цикл
setInterval(() => {
    const dt = 1 / 60;
    
    // Обновление пуль
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
                    p.hp -= b.dmg || 16;
                    if (b.poison) p.poison = 2.0;
                    if (p.hp <= 0) { p.hp = 0; p.alive = false; p.respawnTimer = 3; }
                    io.emit('updateHealth', players);
                    dead = true; break;
                }
            }
        }
        if (dead) bullets.splice(i, 1);
    }

    // Обновление игроков (респавн, яд, ульта)
    let changed = false;
    for (const id in players) {
        const p = players[id];
        if (p.poison > 0) {
            p.poison -= dt;
            p.hp -= 5 * dt; // Урон от яда
            if (p.hp <= 0) { p.hp = 0; p.alive = false; p.respawnTimer = 3; }
            changed = true;
        }
        if (p.ultActive && p.hero === 'VITYA') {
            p.ultTime -= dt;
            if (p.ultTime <= 0) { p.ultActive = false; changed = true; }
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

    // ИИ Ботов
    for (const b of bots) {
        if (!b.alive) {
            b.respawnTimer -= dt;
            if (b.respawnTimer <= 0) {
                const spawn = findSpawnPoint();
                b.x = spawn.x; b.y = spawn.y; b.hp = 100; b.alive = true;
            }
            continue;
        }

        // Ищем ближайшего игрока
        let target = null, best = Infinity;
        for (const id in players) {
            if (players[id].alive) {
                const d = Math.hypot(b.x - players[id].x, b.y - players[id].y);
                if (d < best) { best = d; target = players[id]; }
            }
        }

        if (target) {
            b.aim = Math.atan2(target.y - b.y, target.x - b.x);
            const d = Math.hypot(target.x - b.x, target.y - b.y);
            
            // Движение к цели
            if (d > 250) {
                b.x += Math.cos(b.aim) * 150 * dt;
                b.y += Math.sin(b.aim) * 150 * dt;
                b.walkPhase = (b.walkPhase || 0) + dt * 14;
            }

            // Стрельба
            b.botTimer = (b.botTimer || 0) - dt;
            if (b.botTimer <= 0) {
                b.botTimer = 1.0;
                if (b.hero === 'VITYA') {
                    bullets.push({
                        x: b.x + Math.cos(b.aim)*30, y: b.y + Math.sin(b.aim)*30,
                        vx: Math.cos(b.aim)*900, vy: Math.sin(b.aim)*900,
                        r: 7, dmg: 16, owner: b.id, life: 0.9, color: b.color
                    });
                } else {
                    bullets.push({
                        x: b.x + Math.cos(b.aim)*30, y: b.y + Math.sin(b.aim)*30,
                        vx: Math.cos(b.aim)*500, vy: Math.sin(b.aim)*500,
                        r: 12, dmg: 30, owner: b.id, life: 1.5, color: '#ff7a4d',
                        isBomb: true, poison: true // Боты Лёхи кидают отравленные бомбы
                    });
                }
            }
        }
    }

    // Синхронизация ботов с клиентами
    io.volatile.emit('botsUpdate', bots);
    
    if (bullets.length > 0) {
        io.volatile.emit('bullets', bullets);
    }
}, 1000 / 60);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
