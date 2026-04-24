import { saveAttempts, ScoreEntry } from '@kwizar/shared';
import { AfkPlayer, SaveScore } from './types';

export function saveYahtzeeResults(
    results: (AfkPlayer & { abandon?: boolean })[],
    gameId: string,
    surrenderUserId?: string,
): void {
    const vsBot = results.some(p => p.userId.startsWith('bot-'));
    const sorted = [...results].sort((a, b) => b.total - a.total);
    const scores: ScoreEntry[] = sorted.map((p, i) => ({
        userId: p.userId,
        username: p.username,
        score: p.total,
        placement: i + 1,
        abandon: surrenderUserId === p.userId || (p.abandon ?? false),
        afk: p.afk ?? false,
    }));
    saveAttempts('YAHTZEE', gameId, scores, vsBot);
}
