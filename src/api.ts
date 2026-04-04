import { AfkPlayer, SaveScore } from './types';
import { computeTotal } from './game';

export async function saveAttempts(
    gameType: string,
    gameId: string,
    scores: SaveScore[],
): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;

    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[YAHTZEE] scores saved for ${gameId}`);
    } catch (err) {
        console.error('[YAHTZEE] saveAttempts error:', err);
    }
}

export function saveYahtzeeResults(
    results: (AfkPlayer & { abandon?: boolean })[],
    gameId: string,
    surrenderUserId?: string,
): void {
    const sorted = [...results].sort((a, b) => b.total - a.total);
    const scores: SaveScore[] = sorted.map((p, i) => ({
        userId: p.userId,
        score: p.total,
        placement: i + 1,
        abandon: surrenderUserId === p.userId || (p.abandon ?? false),
        afk: p.afk ?? false,
    }));
    saveAttempts('YAHTZEE', gameId, scores);
}
