import { Room } from './types';
import { createPlayer } from './game';

export const rooms: Record<string, Room> = {};

export function createRoom(code: string, players: any[]): Room {
    rooms[code] = {
        code,
        players: players.map(createPlayer),
        currentPlayerIndex: Math.floor(Math.random() * players.length),
        round: 1,
        phase: 'rolling',
    };
    return rooms[code];
}
