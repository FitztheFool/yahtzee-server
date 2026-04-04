import { AfkPlayer, SaveScore } from './types';

export async function saveAttempts(
    gameType: string,
    gameId: string,
    scores: SaveScore[],
    vsBot = false,
): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;

    const humanScores = scores.filter(s => !s.userId.startsWith('bot-'));
    if (humanScores.length === 0) return;

    const bots = scores
        .filter(s => s.userId.startsWith('bot-'))
        .map((s, i) => ({ username: s.username ?? `Bot ${i + 1}`, score: s.score, placement: s.placement ?? i + 1 }));

    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({ gameType, gameId, vsBot, bots: bots.length > 0 ? bots : undefined, scores: humanScores }),
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
    const vsBot = results.some(p => p.userId.startsWith('bot-'));
    const sorted = [...results].sort((a, b) => b.total - a.total);
    const scores: SaveScore[] = sorted.map((p, i) => ({
        userId: p.userId,
        username: p.username,
        score: p.total,
        placement: i + 1,
        abandon: surrenderUserId === p.userId || (p.abandon ?? false),
        afk: p.afk ?? false,
    }));
    saveAttempts('YAHTZEE', gameId, scores, vsBot);
}
