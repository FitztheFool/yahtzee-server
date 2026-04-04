import { Server } from 'socket.io';
import { Room, Player } from './types';
import { buildState, checkGameEnd, fillScorecard, computeTotal, resetPlayerTurn, initScorecard } from './game';
import { rooms } from './rooms';
import { saveYahtzeeResults } from './api';
import crypto from 'crypto';

export const TURN_DURATION = 120;
export const timers: Record<string, { remaining: number; interval?: ReturnType<typeof setInterval> }> = {};

export function clearTimer(code: string): void {
    if (timers[code]?.interval) clearInterval(timers[code].interval);
    delete timers[code];
}

export function endGameWithAfk(io: Server, code: string, room: Room): void {
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

export function kickAfkPlayer(io: Server, code: string, room: Room, p: Player): void {
    const kickedIdx = room.players.findIndex(pl => pl.userId === p.userId);
    const filledCard = fillScorecard(p.scoreCard);
    const { total } = computeTotal(filledCard);

    if (!room.afkPlayers) room.afkPlayers = [];
    room.afkPlayers.push({ userId: p.userId, username: p.username, total, scoreCard: filledCard, afk: true });
    room.players = room.players.filter(pl => pl.userId !== p.userId);

    if (!room.afkStrikes) room.afkStrikes = {};
    delete room.afkStrikes[p.userId];

    io.to(code).emit('yahtzee:playerKicked', {
        userId: p.userId,
        username: p.username,
        reason: 'inactivity',
        scoreCard: filledCard,
        total,
    });

    if (room.players.length <= 1) {
        endGameWithAfk(io, code, room);
        return;
    }

    if (kickedIdx < room.currentPlayerIndex) room.currentPlayerIndex--;
    room.currentPlayerIndex = room.currentPlayerIndex % room.players.length;

    const next = room.players[room.currentPlayerIndex];
    resetPlayerTurn(next);
    room.phase = 'rolling';

    io.to(code).emit('yahtzee:state', buildState(room));
    startTimer(io, code);
}

export function startTimer(io: Server, code: string): void {
    clearTimer(code);
    timers[code] = { remaining: TURN_DURATION };

    timers[code].interval = setInterval(() => {
        if (!timers[code]) return;
        timers[code].remaining--;

        io.to(code).emit('yahtzee:timer', { remaining: timers[code].remaining });

        const room = rooms[code];
        if (!room) { clearTimer(code); return; }

        const p = room.players[room.currentPlayerIndex];

        // Avertissement AFK à 30s si déjà 1 strike
        if (timers[code].remaining === 30) {
            if ((room.afkStrikes?.[p.userId] ?? 0) >= 1) {
                io.to(code).emit('yahtzee:afkWarning', {
                    userId: p.userId,
                    username: p.username,
                    secondsLeft: 30,
                });
            }
        }

        if (timers[code].remaining > 0) return;

        // Temps écoulé
        clearTimer(code);
        if (p.userId.startsWith('bot-')) { startTimer(io, code); return; }
        if (!room.afkStrikes) room.afkStrikes = {};
        const strikes = (room.afkStrikes[p.userId] ?? 0) + 1;
        room.afkStrikes[p.userId] = strikes;

        if (strikes >= 2) {
            kickAfkPlayer(io, code, room, p);
            return;
        }

        // 1er timeout — auto-score case disponible à 0 + avertissement
        const keys = (Object.keys(initScorecard()) as string[])
            .filter(k => k !== 'yahtzeeBonus' && (p.scoreCard as any)[k] === null);
        if (keys.length > 0) (p.scoreCard as any)[keys[0]] = 0;

        io.to(code).emit('yahtzee:afkWarning', { userId: p.userId, username: p.username, secondsLeft: null });

        if (checkGameEnd(room)) {
            endGameWithAfk(io, code, room);
        } else {
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
            if (room.currentPlayerIndex === 0) room.round++;
            const next = room.players[room.currentPlayerIndex];
            resetPlayerTurn(next);
            room.phase = 'rolling';
            io.to(code).emit('yahtzee:state', buildState(room));
            startTimer(io, code);
        }
    }, 1000);
}
