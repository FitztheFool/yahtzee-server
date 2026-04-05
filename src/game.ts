import { ScoreCard, ScoreCategory, Player, Room } from './types';

// ─── Scorecard ────────────────────────────────────────────────────────────────

export function initScorecard(): ScoreCard {
    return {
        ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
        threeOfAKind: null, fourOfAKind: null, fullHouse: null,
        smallStraight: null, largeStraight: null, yahtzee: null, chance: null,
        yahtzeeBonus: 0,
    };
}

export function computeTotal(scoreCard: ScoreCard): { total: number; upperBonus: number } {
    const upper: ScoreCategory[] = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
    const lower: ScoreCategory[] = ['threeOfAKind', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'];

    const upperSum = upper.reduce((a, k) => a + (scoreCard[k] ?? 0), 0);
    const upperBonus = upperSum >= 63 ? 35 : 0;
    const lowerSum = lower.reduce((a, k) => a + (scoreCard[k] ?? 0), 0);
    const bonusYahtzee = (scoreCard.yahtzeeBonus ?? 0) * 100;

    return { total: upperSum + upperBonus + lowerSum + bonusYahtzee, upperBonus };
}

export function calculateScore(category: ScoreCategory, dice: number[]): number {
    const counts = [0, 0, 0, 0, 0, 0];
    dice.forEach(d => counts[d - 1]++);
    const sum = dice.reduce((a, b) => a + b, 0);
    const sorted = [...dice].sort();

    switch (category) {
        case 'ones': return counts[0] * 1;
        case 'twos': return counts[1] * 2;
        case 'threes': return counts[2] * 3;
        case 'fours': return counts[3] * 4;
        case 'fives': return counts[4] * 5;
        case 'sixes': return counts[5] * 6;
        case 'threeOfAKind': return counts.some(c => c >= 3) ? sum : 0;
        case 'fourOfAKind': return counts.some(c => c >= 4) ? sum : 0;
        case 'fullHouse': return counts.some(c => c === 3) && counts.some(c => c === 2) ? 25 : 0;
        case 'smallStraight': {
            const u = [...new Set(sorted)].join('');
            return ['1234', '2345', '3456'].some(s => u.includes(s)) ? 30 : 0;
        }
        case 'largeStraight': {
            const u = [...new Set(sorted)].join('');
            return u === '12345' || u === '23456' ? 40 : 0;
        }
        case 'yahtzee': return counts.some(c => c === 5) ? 50 : 0;
        case 'chance': return sum;
        default: return 0;
    }
}

/** Remplit toutes les cases null d'une scorecard à 0. */
export function fillScorecard(scoreCard: ScoreCard): ScoreCard {
    const keys = (Object.keys(initScorecard()) as (keyof ScoreCard)[]).filter((k): k is ScoreCategory => k !== 'yahtzeeBonus');
    const filled = { ...scoreCard };
    for (const k of keys) if (filled[k] === null) filled[k] = 0;
    return filled;
}

// ─── État de jeu ──────────────────────────────────────────────────────────────

export function checkGameEnd(room: Room): boolean {
    const keys = (Object.keys(initScorecard()) as (keyof ScoreCard)[]).filter((k): k is ScoreCategory => k !== 'yahtzeeBonus');
    return room.players.every(p => keys.every(k => p.scoreCard[k] !== null));
}

export function buildState(room: Room) {
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

/** Crée un joueur initial (dés à 0, scorecard vide). */
export function createPlayer(raw: { userId?: string; id?: string; username?: string; name?: string }): Player {
    return {
        userId: raw.userId ?? raw.id ?? '',
        username: raw.username ?? raw.name ?? 'Joueur',
        dice: [0, 0, 0, 0, 0],
        held: [false, false, false, false, false],
        rollsLeft: 3,
        scoreCard: initScorecard(),
    };
}

/** Réinitialise le tour d'un joueur (nouveau tour). */
export function resetPlayerTurn(p: Player): void {
    p.dice = [0, 0, 0, 0, 0];
    p.held = [false, false, false, false, false];
    p.rollsLeft = 3;
}

/** Lance les dés non bloqués du joueur. */
export function rollDice(p: Player): void {
    p.dice = p.dice.map((d, i) => p.held[i] ? d : Math.ceil(Math.random() * 6));
    p.rollsLeft--;
}
