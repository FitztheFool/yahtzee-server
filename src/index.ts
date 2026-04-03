// yahtzee-server/src/index.ts
import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from 'dotenv';
import crypto from 'crypto';
import { jwtVerify } from 'jose';
dotenv.config();

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.FRONTEND_URL, methods: ["GET", "POST"], credentials: true } });

const rooms: Record<string, any> = {};
const timers: Record<string, any> = {};
const TURN_DURATION = 120; // 2 minutes


function startTimer(code: string) {
    clearTimer(code);
    timers[code] = { remaining: TURN_DURATION };
    timers[code].interval = setInterval(() => {
        if (!timers[code]) return;
        timers[code].remaining--;
        io.to(code).emit("yahtzee:timer", { remaining: timers[code].remaining });
        if (timers[code].remaining === 30) {
            const room = rooms[code];
            if (room) {
                const p = room.players[room.currentPlayerIndex];
                if (p && (room.afkStrikes?.[p.userId] ?? 0) >= 1) {
                    io.to(code).emit('yahtzee:afkWarning', { userId: p.userId, username: p.username, secondsLeft: 30 });
                }
            }
        }
        if (timers[code].remaining <= 0) {
            clearTimer(code);
            const room = rooms[code];
            if (!room) return;
            const p = room.players[room.currentPlayerIndex];
            if (!room.afkStrikes) room.afkStrikes = {};
            const strikes = (room.afkStrikes[p.userId] ?? 0) + 1;
            room.afkStrikes[p.userId] = strikes;

            if (strikes >= 2) {
                kickAfkPlayer(code, room, p);
                return;
            }

            // 1er timeout — auto-score et avertissement
            const keys = Object.keys(p.scoreCard).filter(k => k !== "yahtzeeBonus" && p.scoreCard[k] === null);
            if (keys.length > 0) {
                p.scoreCard[keys[0]] = 0;
            }
            io.to(code).emit('yahtzee:afkWarning', { userId: p.userId, username: p.username, secondsLeft: null });

            if (checkGameEnd(room)) {
                endGameWithAfk(code, room);
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

function clearTimer(code: string) {
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

function computeTotal(scoreCard: any) {
    const upper = ["ones", "twos", "threes", "fours", "fives", "sixes"];
    const lower = ["threeOfAKind", "fourOfAKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"];
    const upperSum = upper.reduce((a, k) => a + (scoreCard[k] ?? 0), 0);
    const upperBonus = upperSum >= 63 ? 35 : 0;
    const lowerSum = lower.reduce((a, k) => a + (scoreCard[k] ?? 0), 0);
    const bonusYahtzee = (scoreCard.yahtzeeBonus ?? 0) * 100;
    return { total: upperSum + upperBonus + lowerSum + bonusYahtzee, upperBonus };
}

function calculateScore(category: string, dice: number[]): number {
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

function buildState(room: any) {
    const players = room.players.map((p: any) => {
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

function createRoom(code: string, players: any[]) {
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

function checkGameEnd(room: any): boolean {
    return room.players.every((p: any) => {
        const keys = Object.keys(initScorecard()).filter((k: string) => k !== "yahtzeeBonus");
        return keys.every((k: string) => p.scoreCard[k] !== null);
    });
}

async function saveAttempts(gameType: string, gameId: string, scores: { userId: string; score: number; placement?: number; abandon?: boolean; afk?: boolean }[]) {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;
    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[${gameType}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType}] saveAttempts error:`, err);
    }
}

function saveYahtzeeResults(results: any[], gameId: string, surrenderUserId?: string) {
    const sorted = [...results].sort((a: any, b: any) => b.total - a.total);
    const scores = sorted.map((p: any, i: number) => ({
        userId: p.userId,
        score: p.total,
        placement: i + 1,
        abandon: surrenderUserId === p.userId || (p.abandon ?? false),
        afk: p.afk ?? false,
    }));
    saveAttempts('YAHTZEE', gameId, scores);
}

function endGameWithAfk(code: string, room: any) {
    clearTimer(code);
    room.phase = 'ended';
    const state = buildState(room);
    const results = [
        ...state.players.map((pl: any) => ({ userId: pl.userId, username: pl.username, total: pl.total, scoreCard: pl.scoreCard })),
        ...(room.afkPlayers ?? []),
    ];
    const gameId = crypto.randomUUID();
    io.to(code).emit('yahtzee:finished', { results, gameId });
    saveYahtzeeResults(results, gameId);
    delete rooms[code];
}

function fillScorecard(scoreCard: any) {
    const keys = Object.keys(initScorecard()).filter(k => k !== "yahtzeeBonus");
    const filled = { ...scoreCard };
    for (const k of keys) if (filled[k] === null) filled[k] = 0;
    return filled;
}

function kickAfkPlayer(code: string, room: any, p: any) {
    const kickedIdx = room.players.findIndex((pl: any) => pl.userId === p.userId);
    const filledCard = fillScorecard(p.scoreCard);
    const { total } = computeTotal(filledCard);
    if (!room.afkPlayers) room.afkPlayers = [];
    room.afkPlayers.push({ userId: p.userId, username: p.username, total, scoreCard: filledCard, afk: true });
    room.players = room.players.filter((pl: any) => pl.userId !== p.userId);
    if (!room.afkStrikes) room.afkStrikes = {};
    delete room.afkStrikes[p.userId];

    const { total: kickedTotal } = computeTotal(filledCard);
    io.to(code).emit('yahtzee:playerKicked', { userId: p.userId, username: p.username, reason: 'inactivity', scoreCard: filledCard, total: kickedTotal });

    if (room.players.length <= 1) {
        endGameWithAfk(code, room);
        return;
    }

    if (kickedIdx < room.currentPlayerIndex) {
        room.currentPlayerIndex--;
    }
    room.currentPlayerIndex = room.currentPlayerIndex % room.players.length;
    const next = room.players[room.currentPlayerIndex];
    next.dice = [0, 0, 0, 0, 0];
    next.held = [false, false, false, false, false];
    next.rollsLeft = 3;
    room.phase = 'rolling';
    io.to(code).emit('yahtzee:state', buildState(room));
    startTimer(code);
}

const SOCKET_SECRET = new TextEncoder().encode(process.env.INTERNAL_API_KEY!);

io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('auth_required'));
    try {
        const { payload } = await jwtVerify(token, SOCKET_SECRET);
        socket.data.userId = payload.sub as string;
        socket.data.username = payload.username as string;
        next();
    } catch {
        next(new Error('invalid_token'));
    }
});

io.on("connection", (socket) => {
    console.log("[Yahtzee] nouvelle connexion", socket.id);

    socket.on("yahtzee:configure", ({ lobbyId: code, players }, ack) => {
        const room = createRoom(code, players);
        console.log(`[Yahtzee] Room created: ${code}`);
        socket.join(code);
        io.to(code).emit("yahtzee:state", buildState(room));
        startTimer(code);
        if (typeof ack === 'function') ack();
    });

    socket.on("yahtzee:join", ({ lobbyId: code }) => {
        const { userId } = socket.data;
        socket.data.lobbyId = code;
        socket.join(code);
        const room = rooms[code];
        if (!room) { socket.emit('notFound'); return; }
        socket.emit("yahtzee:state", buildState(room));
    });

    socket.on("yahtzee:roll", ({ lobbyId: code, userId }) => {
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft <= 0 || room.phase !== "rolling") return;

        if (!room.afkStrikes) room.afkStrikes = {};
        room.afkStrikes[p.userId] = 0;
        p.dice = p.dice.map((d: number, i: number) => p.held[i] ? d : Math.ceil(Math.random() * 6));
        p.rollsLeft--;
        if (p.rollsLeft === 0) room.phase = "scoring";

        io.to(code).emit("yahtzee:state", buildState(room));
        if (room.phase === "rolling") startTimer(code);
    });

    socket.on("yahtzee:toggleHold", ({ lobbyId: code, userId, index }) => {
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft === 3 || p.rollsLeft === 0) return;

        p.held[index] = !p.held[index];
        io.to(code).emit("yahtzee:state", buildState(room));
    });

    socket.on("yahtzee:score", ({ lobbyId: code, userId, category }) => {
        if (socket.data?.userId !== userId) return;
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

        if (!room.afkStrikes) room.afkStrikes = {};
        room.afkStrikes[p.userId] = 0;
        p.scoreCard[category] = calculateScore(category, p.dice);

        if (checkGameEnd(room)) {
            room.phase = "ended";
            const state = buildState(room);
            const results = [
                ...state.players.map((pl: any) => ({ userId: pl.userId, username: pl.username, total: pl.total, scoreCard: pl.scoreCard })),
                ...(room.afkPlayers ?? []),
            ];
            const gameId = crypto.randomUUID();
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
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (!room.afkStrikes) room.afkStrikes = {};
        room.afkStrikes[p.userId] = 0;
        room.phase = "scoring";
        io.to(code).emit("yahtzee:state", buildState(room));
    });

    socket.on("yahtzee:surrender", ({ lobbyId: code }) => {
        const room = rooms[code];
        if (!room || room.phase === 'ended') return;
        const surrenderUserId = socket.data?.userId;

        if (room.players.length > 2) {
            const surrenderIdx = room.players.findIndex((pl: any) => pl.userId === surrenderUserId);
            if (surrenderIdx === -1) return;
            const p = room.players[surrenderIdx];
            const filledCard = fillScorecard(p.scoreCard);
            const { total } = computeTotal(filledCard);
            if (!room.afkPlayers) room.afkPlayers = [];
            room.afkPlayers.push({ userId: p.userId, username: p.username, total, scoreCard: filledCard, abandon: true, afk: false });
            room.players = room.players.filter((pl: any) => pl.userId !== surrenderUserId);
            io.to(code).emit('yahtzee:playerSurrendered', { userId: p.userId, username: p.username, scoreCard: filledCard, total });

            clearTimer(code);
            // Si le joueur qui abandonne était avant le joueur courant, décrémenter l'index
            if (surrenderIdx < room.currentPlayerIndex) {
                room.currentPlayerIndex--;
            }
            room.currentPlayerIndex = room.currentPlayerIndex % room.players.length;
            const next = room.players[room.currentPlayerIndex];
            next.dice = [0, 0, 0, 0, 0];
            next.held = [false, false, false, false, false];
            next.rollsLeft = 3;
            room.phase = 'rolling';
            io.to(code).emit('yahtzee:state', buildState(room));
            startTimer(code);
        } else {
            clearTimer(code);
            room.phase = 'ended';
            const surrendererPlayer = room.players.find((pl: any) => pl.userId === surrenderUserId);
            const surrendererFilledCard = surrendererPlayer ? fillScorecard(surrendererPlayer.scoreCard) : null;
            const { total: surrendererTotal } = surrendererFilledCard ? computeTotal(surrendererFilledCard) : { total: 0 };
            const state = buildState(room);
            const remaining = state.players.filter((pl: any) => pl.userId !== surrenderUserId);
            const results = [
                ...remaining.map((pl: any) => ({ userId: pl.userId, username: pl.username, total: pl.total, scoreCard: pl.scoreCard })),
                ...(surrendererPlayer ? [{ userId: surrendererPlayer.userId, username: surrendererPlayer.username, total: surrendererTotal, scoreCard: surrendererFilledCard, abandon: true }] : []),
                ...(room.afkPlayers ?? []),
            ];
            const gameId = crypto.randomUUID();
            io.to(code).emit('yahtzee:finished', { results, gameId });
            saveYahtzeeResults(results, gameId, surrenderUserId);
        }
    });

    socket.on("disconnect", () => {
        console.log(`[Yahtzee] Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 10005;
server.listen(PORT, () => console.log("[YAHTZEE] realtime listening on", PORT));


const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
