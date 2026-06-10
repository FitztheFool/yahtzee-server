import type { Server } from 'socket.io';
import { saveAttemptsAndEmit, ScoreEntry } from '@kwizar/shared';
import { AfkPlayer, SaveScore } from './types';

export function saveYahtzeeResults(
    io: Server,
    room: string,
    results: (AfkPlayer & { abandon?: boolean })[],
    gameId: string,
    surrenderUserId?: string,
): void {
    const vsBot = results.some(p => p.userId.startsWith('bot-'));
    const isAbandon = (p: AfkPlayer & { abandon?: boolean }) =>
        surrenderUserId === p.userId || (p.abandon ?? false);
    const isAfk = (p: AfkPlayer & { abandon?: boolean }) => p.afk ?? false;

    const finishers = results.filter(p => !isAbandon(p) && !isAfk(p));
    const sortedFinishers = [...finishers].sort((a, b) => b.total - a.total);

    const scores: ScoreEntry[] = results.map(p => {
        const abandon = isAbandon(p);
        const afk = isAfk(p);
        const placement = abandon || afk
            ? null
            : sortedFinishers.findIndex(x => x.userId === p.userId) + 1;
        return {
            userId: p.userId,
            username: p.username,
            score: p.total,
            placement,
            abandon,
            afk,
        };
    });
    saveAttemptsAndEmit(io, room, 'YAHTZEE', gameId, scores, vsBot);
}
