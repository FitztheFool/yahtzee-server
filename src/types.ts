export interface Player {
    userId: string;
    username: string;
    dice: number[];
    held: boolean[];
    rollsLeft: number;
    scoreCard: ScoreCard;
}

export interface ScoreCard {
    ones: number | null;
    twos: number | null;
    threes: number | null;
    fours: number | null;
    fives: number | null;
    sixes: number | null;
    threeOfAKind: number | null;
    fourOfAKind: number | null;
    fullHouse: number | null;
    smallStraight: number | null;
    largeStraight: number | null;
    yahtzee: number | null;
    chance: number | null;
    yahtzeeBonus: number;
}

export type ScoreCategory = Exclude<keyof ScoreCard, 'yahtzeeBonus'>;

export type GamePhase = 'rolling' | 'scoring' | 'ended';

export interface Room {
    code: string;
    players: Player[];
    currentPlayerIndex: number;
    round: number;
    phase: GamePhase;
    afkStrikes?: Record<string, number>;
    afkPlayers?: AfkPlayer[];
}

export interface AfkPlayer {
    userId: string;
    username: string;
    total: number;
    scoreCard: ScoreCard;
    afk?: boolean;
    abandon?: boolean;
}

export interface SaveScore {
    userId: string;
    score: number;
    placement?: number;
    abandon?: boolean;
    afk?: boolean;
}
