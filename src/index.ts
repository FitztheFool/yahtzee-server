import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { setupSocketAuth, corsConfig } from '@kwizar/shared';

import { ScoreCard, ScoreCategory } from './types';
import {
    buildState, checkGameEnd, calculateScore,
    fillScorecard, computeTotal, resetPlayerTurn, rollDice,
} from './game';
import { rooms, createRoom } from './rooms';
import { startTimer, clearTimer, timerCallbacks } from './timer';
import { saveYahtzeeResults } from './api';

// ─── Bot strategy ─────────────────────────────────────────────────────────────

function botChooseHeld(dice: number[], scoreCard: ScoreCard): boolean[] {
    const counts = [0, 0, 0, 0, 0, 0];
    dice.forEach(d => counts[d - 1]++);
    const maxCount = Math.max(...counts);

    if (maxCount >= 3) {
        const val = counts.indexOf(maxCount) + 1;
        return dice.map(d => d === val);
    }

    const pairVals = counts.map((c, i) => c >= 2 ? i + 1 : null).filter(Boolean) as number[];
    if (pairVals.length >= 2) return dice.map(d => pairVals.includes(d));
    if (pairVals.length === 1) return dice.map(d => d === pairVals[0]);

    const uniq = [...new Set(dice)].sort((a, b) => a - b);
    let bestStart = 0, bestLen = 1, curStart = 0, curLen = 1;
    for (let i = 1; i < uniq.length; i++) {
        if (uniq[i] === uniq[i - 1] + 1) {
            curLen++;
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        } else { curStart = i; curLen = 1; }
    }
    if (bestLen >= 3) {
        const seqVals = new Set(uniq.slice(bestStart, bestStart + bestLen));
        const held = [false, false, false, false, false];
        const used = new Set<number>();
        dice.forEach((d, i) => { if (seqVals.has(d) && !used.has(d)) { held[i] = true; used.add(d); } });
        return held;
    }

    return dice.map(d => d >= 4);
}

function botChooseCategory(dice: number[], scoreCard: ScoreCard): ScoreCategory {
    const all: ScoreCategory[] = [
        'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
        'threeOfAKind', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance',
    ];
    const available = all.filter(k => scoreCard[k] === null);
    const sacrifice: Record<ScoreCategory, number> = {
        yahtzee: 50, largeStraight: 40, smallStraight: 30, fullHouse: 25,
        fourOfAKind: 20, threeOfAKind: 15, chance: 10,
        sixes: 9, fives: 8, fours: 7, threes: 6, twos: 5, ones: 4,
    };
    let best = available[0];
    let bestValue = -Infinity;
    for (const cat of available) {
        const score = calculateScore(cat, dice);
        const value = score > 0 ? score : -sacrifice[cat];
        if (value > bestValue) { bestValue = value; best = cat; }
    }
    return best;
}

function doScore(code: string, category: ScoreCategory): void {
    const room = rooms[code];
    if (!room) return;
    const p = room.players[room.currentPlayerIndex];
    if (category !== 'yahtzee' && p.scoreCard.yahtzee === 50 && calculateScore('yahtzee', p.dice) === 50) {
        p.scoreCard.yahtzeeBonus = (p.scoreCard.yahtzeeBonus ?? 0) + 1;
    }
    if (!room.afkStrikes) room.afkStrikes = {};
    room.afkStrikes[p.userId] = 0;
    p.scoreCard[category] = calculateScore(category, p.dice);

    if (checkGameEnd(room)) {
        room.phase = 'ended';
        const state = buildState(room);
        const results = [
            ...state.players.map((pl: any) => ({ userId: pl.userId, username: pl.username, total: pl.total, scoreCard: pl.scoreCard })),
            ...(room.afkPlayers ?? []),
        ];
        const gameId = crypto.randomUUID();
        clearTimer(code);
        io.to(code).emit('yahtzee:ended', { results, gameId });
        saveYahtzeeResults(results, gameId);
    } else {
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
        if (room.currentPlayerIndex === 0) room.round++;
        const next = room.players[room.currentPlayerIndex];
        resetPlayerTurn(next);
        room.phase = 'rolling';
        io.to(code).emit('yahtzee:state', buildState(room));
        startTimer(io, code);
        botTakeTurnIfNeeded(code);
    }
}

function botTakeTurnIfNeeded(code: string): void {
    const room = rooms[code];
    if (!room || room.phase === 'ended') return;
    const p = room.players[room.currentPlayerIndex];
    if (!p?.userId.startsWith('bot-')) return;
    clearTimer(code);
    botRoll(code);
}

function botRoll(code: string): void {
    setTimeout(() => {
        const room = rooms[code];
        if (!room || room.phase === 'ended') return;
        const p = room.players[room.currentPlayerIndex];
        if (!p?.userId.startsWith('bot-')) return;

        if (room.phase === 'scoring' || p.rollsLeft === 0) { botDoScore(code); return; }

        if (p.rollsLeft < 3) p.held = botChooseHeld(p.dice, p.scoreCard);
        rollDice(p);
        if (p.rollsLeft === 0) room.phase = 'scoring';
        io.to(code).emit('yahtzee:state', buildState(room));

        room.phase === 'rolling' ? botRoll(code) : botDoScore(code);
    }, 700);
}

function botDoScore(code: string): void {
    setTimeout(() => {
        const room = rooms[code];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (!p?.userId.startsWith('bot-')) return;
        doScore(code, botChooseCategory(p.dice, p.scoreCard));
    }, 700);
}

timerCallbacks.onTurnChange = botTakeTurnIfNeeded;

dotenv.config();

const app = express();
app.get('/health', (_req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.status(200).send('ok'); });

const server = http.createServer(app);
const io = new Server(server, { cors: corsConfig, maxHttpBufferSize: 1e5 });

setupSocketAuth(io, new TextEncoder().encode(process.env.INTERNAL_API_KEY!));

// ─── Socket events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('[Yahtzee] nouvelle connexion', socket.id);

    socket.on('yahtzee:configure', ({ lobbyId: code, players }: { lobbyId: string; players: any[] }, ack?: () => void) => {
        const room = createRoom(code, players);
        console.log(`[Yahtzee] Room created: ${code}`);
        socket.join(code);
        io.to(code).emit('yahtzee:state', buildState(room));
        startTimer(io, code);
        setTimeout(() => botTakeTurnIfNeeded(code), 1000);
        if (typeof ack === 'function') ack();
    });

    socket.on('yahtzee:join', ({ lobbyId: code }: { lobbyId: string }) => {
        socket.data.lobbyId = code;
        socket.join(code);
        const room = rooms[code];
        if (!room) { socket.emit('notFound'); return; }
        socket.emit('yahtzee:state', buildState(room));
    });

    socket.on('yahtzee:roll', ({ lobbyId: code, userId }: { lobbyId: string; userId: string }) => {
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;

        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft <= 0 || room.phase !== 'rolling') return;

        if (!room.afkStrikes) room.afkStrikes = {};
        room.afkStrikes[p.userId] = 0;

        rollDice(p);
        if (p.rollsLeft === 0) room.phase = 'scoring';

        io.to(code).emit('yahtzee:state', buildState(room));
        if (room.phase === 'rolling') startTimer(io, code);
    });

    socket.on('yahtzee:toggleHold', ({ lobbyId: code, userId, index }: { lobbyId: string; userId: string; index: number }) => {
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;

        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft === 3 || p.rollsLeft === 0) return;

        p.held[index] = !p.held[index];
        io.to(code).emit('yahtzee:state', buildState(room));
    });

    socket.on('yahtzee:score', ({ lobbyId: code, userId, category }: { lobbyId: string; userId: string; category: ScoreCategory }) => {
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;

        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;
        if (p.rollsLeft === 3) return;
        if (p.scoreCard[category] !== null) return;

        doScore(code, category);
    });

    socket.on('yahtzee:forceScore', ({ lobbyId: code, userId }: { lobbyId: string; userId: string }) => {
        if (socket.data?.userId !== userId) return;
        const room = rooms[code];
        if (!room) return;

        const p = room.players[room.currentPlayerIndex];
        if (p.userId !== userId) return;

        if (!room.afkStrikes) room.afkStrikes = {};
        room.afkStrikes[p.userId] = 0;
        room.phase = 'scoring';
        io.to(code).emit('yahtzee:state', buildState(room));
    });

    socket.on('yahtzee:surrender', ({ lobbyId: code }: { lobbyId: string }) => {
        const room = rooms[code];
        if (!room || room.phase === 'ended') return;

        const surrenderUserId = socket.data?.userId as string;

        if (room.players.length > 2) {
            // Partie multi : retirer le joueur et continuer
            const surrenderIdx = room.players.findIndex(pl => pl.userId === surrenderUserId);
            if (surrenderIdx === -1) return;

            const p = room.players[surrenderIdx];
            const filledCard = fillScorecard(p.scoreCard);
            const { total } = computeTotal(filledCard);

            if (!room.afkPlayers) room.afkPlayers = [];
            room.afkPlayers.push({ userId: p.userId, username: p.username, total, scoreCard: filledCard, abandon: true, afk: false });
            room.players = room.players.filter(pl => pl.userId !== surrenderUserId);

            io.to(code).emit('yahtzee:playerSurrendered', { userId: p.userId, username: p.username, scoreCard: filledCard, total });

            clearTimer(code);
            if (surrenderIdx < room.currentPlayerIndex) room.currentPlayerIndex--;
            room.currentPlayerIndex = room.currentPlayerIndex % room.players.length;

            const next = room.players[room.currentPlayerIndex];
            resetPlayerTurn(next);
            room.phase = 'rolling';
            io.to(code).emit('yahtzee:state', buildState(room));
            startTimer(io, code);
        } else {
            // Partie 1v1 : fin immédiate
            clearTimer(code);
            room.phase = 'ended';

            const surrendererPlayer = room.players.find(pl => pl.userId === surrenderUserId);
            const surrendererFilledCard = surrendererPlayer ? fillScorecard(surrendererPlayer.scoreCard) : null;
            const { total: surrendererTotal } = surrendererFilledCard ? computeTotal(surrendererFilledCard) : { total: 0 };

            const state = buildState(room);
            const remaining = state.players.filter((pl: any) => pl.userId !== surrenderUserId);
            const results = [
                ...remaining.map((pl: any) => ({ userId: pl.userId, username: pl.username, total: pl.total, scoreCard: pl.scoreCard })),
                ...(surrendererPlayer ? [{
                    userId: surrendererPlayer.userId,
                    username: surrendererPlayer.username,
                    total: surrendererTotal,
                    scoreCard: surrendererFilledCard,
                    abandon: true,
                }] : []),
                ...(room.afkPlayers ?? []),
            ];

            const gameId = crypto.randomUUID();
            io.to(code).emit('yahtzee:finished', { results, gameId });
            saveYahtzeeResults(results, gameId, surrenderUserId);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[Yahtzee] Disconnected: ${socket.id}`);
    });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 10005;
server.listen(PORT, () => console.log('[YAHTZEE] realtime listening on', PORT));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
