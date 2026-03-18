// yahtzee-server/src/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
require('dotenv').config();

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.FRONTEND_URL, methods: ["GET", "POST"], credentials: true } });

const rooms = {};
const timers = {}; // code → { interval, remaining }
const TURN_DURATION = 120; // 2 minutes

function startTimer(code) {
    clearTimer(code);
    timers[code] = { remaining: TURN_DURATION };
    timers[code].interval = setInterval(() => {
        if (!timers[code]) return;
        timers[code].remaining--;
        io.to(code).emit("yahtzee:timer", { remaining: timers[code].remaining });
        if (timers[code].remaining <= 0) {
            clearTimer(code);
            const room = rooms[code];
            if (!room) return;
            const p = room.players[room.currentPlayerIndex];
            // Auto-score: find first available category
            const keys = Object.keys(p.scoreCard).filter(k => k !== "yahtzeeBonus" && p.scoreCard[k] === null);
            if (keys.length > 0) {
                p.scoreCard[keys[0]] = 0; // forfeit = 0
            }
            if (checkGameEnd(room)) {
                room.phase = "ended";
                const state = buildState(room);
                const results = state.players.map(pl => ({ userId: pl.userId, username: pl.username, total: pl.total }));
                const gameId = require('crypto').randomUUID();
                clearTimer(code);
                io.to(code).emit("yahtzee:ended", { results, gameId });
                saveYahtzeeResults(results, gameId);
            } else {
                room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
                if (room.currentPlayerIndex === 0) room.round++;
                const next = room.players[room.currentPlayerIndex];
                next.dice = [0, 0, 0, 0, 0];
                next.held = [false, false, false, false, false];
                next.rollsLeft = 3;
                room.phase = "rolling";
                io.to(code).emit("yahtzee:state", buildState(room));
                startTimer(code);
            }
        }
    }, 1000);
}

function clearTimer(code) {
    if (timers[code]?.interval) clearInterval(timers[code].interval);
    delete timers[code];
}

function initScorecard() {
    return {
        ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
        threeOfAKind: null, fourOfAKind: null, fullHouse: null,
        smallStraight: null, largeStraight: null, yahtzee: null, chance: null,
        yahtzeeBonus: 0,
    };
}

function computeTotal(scoreCard) {
    const upper = ["ones", "twos", "threes", "fours", "fives", "sixes"];
    const lower = ["threeOfAKind", "fourOfAKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"];
    const upperSum = upper.reduce((a, k) => a + (scoreCard[k] ?? 0), 0);
    const upperBonus = upperSum >= 63 ? 35 : 0;
    const lowerSum = lower.reduce((a, k) => a + (scoreCard[k] ?? 0), 0);
    const bonusYahtzee = (scoreCard.yahtzeeBonus ?? 0) * 100;
    return { total: upperSum + upperBonus + lowerSum + bonusYahtzee, upperBonus };
}

function calculateScore(category, dice) {
    const counts = [0, 0, 0, 0, 0, 0];
    dice.forEach(d => counts[d - 1]++);
    const sum = dice.reduce((a, b) => a + b, 0);
    const sorted = [...dice].sort();
    switch (category) {
        case "ones": return counts[0] * 1;
        case "twos": return counts[1] * 2;
        case "threes": return counts[2] * 3;
        case "fours": return counts[3] * 4;
        case "fives": return counts[4] * 5;
        case "sixes": return counts[5] * 6;
        case "threeOfAKind": return counts.some(c => c >= 3) ? sum : 0;
        case "fourOfAKind": return counts.some(c => c >= 4) ? sum : 0;
        case "fullHouse": return counts.some(c => c === 3) && counts.some(c => c === 2) ? 25 : 0;
        case "smallStraight": { const u = [...new Set(sorted)].join(""); return ["1234", "2345", "3456"].some(s => u.includes(s)) ? 30 : 0; }
        case "largeStraight": { const u = [...new Set(sorted)].join(""); return u === "12345" || u === "23456" ? 40 : 0; }
        case "yahtzee": return counts.some(c => c === 5) ? 50 : 0;
        case "chance": return sum;
        default: return 0;
    }
}

function buildState(room) {
    const players = room.players.map(p => {
        const { total, upperBonus } = computeTotal(p.scoreCard);
        return { ...p, total, upperBonus };
    });
    const currentPlayer = players[room.currentPlayerIndex];
    return {
        players,
        currentIndex: room.currentPlayerIndex,
        currentUserId: currentPlayer?.userId,
        turn: room.round,
        phase: room.phase,
    };
}

function createRoom(code, players) {
    rooms[code] = {
        code,
        players: players.map(p => ({
            userId: p.userId ?? p.id,
            username: p.username ?? p.name ?? "Joueur",
            dice: [0, 0, 0, 0, 0],
            held: [false, false, false, false, false],
            rollsLeft: 3,
            scoreCard: initScorecard(),
        })),
        currentPlayerIndex: 0,
        round: 1,
        phase: "rolling",
    };
    return rooms[code];
}

function checkGameEnd(room) {
    return room.players.every(p => {
        const keys = Object.keys(initScorecard()).filter(k => k !== "yahtzeeBonus");
        return keys.every(k => p.scoreCard[k] !== null);
    });
}

function saveYahtzeeResults(results, gameId) {
    console.log('[Yahtzee] saving results:', JSON.stringify(results));

    const sorted = [...results].sort((a, b) => b.total - a.total);

    sorted.forEach((p, i) => {
        const body = JSON.stringify({
            userId: p.userId,
            gameType: 'YAHTZEE',
            gameId,
            score: p.total,
            placement: i + 1,
        });

        const url = new URL(`${process.env.FRONTEND_URL}/api/attempt`);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        };

        const req = (url.protocol === 'https:' ? require('https') : require('http')).request(options, res => {
            console.log(`[Yahtzee] attempt saved for ${p.username}:`, res.statusCode);
        });
        req.on('error', err => console.error('[Yahtzee] attempt error:', err.message));
        req.write(body);
        req.end();
    });
}

io.on("connection", (socket) => {
    console.log("[Yahtzee] nouvelle connexion", socket.id);

    socket.on("yahtzee:init", ({ lobbyId: code, players }) => {
        const room = createRoom(code, players);
        console.log(`[Yahtzee] Room created: ${code}`);
        socket.join(code);
        io.to(code).emit("yahtzee:state", buildState(room));
        startTimer(code);
    });

    socket.on("yahtzee:join", ({ lobbyId: code }) => {
        socket.join(code);
        const room = rooms[code];
        if (room) socket.emit("yahtzee:state", buildState(room));
    });

    socket.on("yahtzee:roll", ({ lobbyId: code, userId }) => {
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft <= 0 || room.phase !== "rolling") return;

        p.dice = p.dice.map((d, i) => p.held[i] ? d : Math.ceil(Math.random() * 6));
        p.rollsLeft--;
        if (p.rollsLeft === 0) room.phase = "scoring";

        io.to(code).emit("yahtzee:state", buildState(room));
        if (room.phase === "rolling") startTimer(code);
    });

    socket.on("yahtzee:toggleHold", ({ lobbyId: code, userId, index }) => {
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft === 3 || p.rollsLeft === 0) return;

        p.held[index] = !p.held[index];
        io.to(code).emit("yahtzee:state", buildState(room));
    });

    socket.on("yahtzee:score", ({ lobbyId: code, userId, category }) => {
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft === 3) return;
        if (p.scoreCard[category] !== null) return;

        // Yahtzee bonus
        if (category !== "yahtzee" && p.scoreCard.yahtzee === 50 && calculateScore("yahtzee", p.dice) === 50) {
            p.scoreCard.yahtzeeBonus = (p.scoreCard.yahtzeeBonus ?? 0) + 1;
        }

        p.scoreCard[category] = calculateScore(category, p.dice);

        if (checkGameEnd(room)) {
            room.phase = "ended";
            const state = buildState(room);
            const results = state.players.map(pl => ({
                userId: pl.userId, username: pl.username, total: pl.total
            }));
            const gameId = require('crypto').randomUUID();
            clearTimer(code);
            io.to(code).emit("yahtzee:ended", { results, gameId });
            saveYahtzeeResults(results, gameId);
        } else {
            // next turn
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
            if (room.currentPlayerIndex === 0) room.round++;
            const next = room.players[room.currentPlayerIndex];
            next.dice = [0, 0, 0, 0, 0];
            next.held = [false, false, false, false, false];
            next.rollsLeft = 3;
            room.phase = "rolling";
            io.to(code).emit("yahtzee:state", buildState(room));
            startTimer(code);
        }
    });

    socket.on("yahtzee:forceScore", ({ lobbyId: code, userId }) => {
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        room.phase = "scoring";
        io.to(code).emit("yahtzee:state", buildState(room));
    });

    socket.on("disconnect", () => {
        console.log(`[Yahtzee] Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("lobby-server listening on", PORT));
