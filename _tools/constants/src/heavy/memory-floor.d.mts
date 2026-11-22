// Types for memory-floor.mjs: a held heavy command never starts below the room a person's turn needs.
import type { RoomAnswer } from "../memory-room.mjs";

export const START_FLOOR_BYTES: number;

export interface BigProcess {
    readonly pid: number;
    readonly name: string;
    readonly bytes: number;
    // The conversation it runs for (INTENTIC_TURN_OWNER), where it says.
    readonly owner: string | undefined;
}

export function belowFloor(answer: Pick<RoomAnswer, "verdict" | "freeBytes">): boolean;
export function biggestProcesses(count?: number, proc?: string): BigProcess[];
export function floorWords(
    label: string,
    answer: Pick<RoomAnswer, "freeBytes" | "needBytes" | "diagnosis" | "priced">,
    at: { readonly waitedMs: number; readonly ceilingMs: number; readonly biggest?: readonly BigProcess[] },
): string;
export function waitWords(
    label: string,
    answer: Pick<RoomAnswer, "verdict" | "waitedMs" | "freeBytes" | "diagnosis" | "waitedFor" | "stuck" | "priced">,
): string | undefined;
export function notStartedWords(label: string, answer: Pick<RoomAnswer, "freeBytes" | "diagnosis">, waitedMs: number): string;
export function holdAtFloor(options: {
    readonly answer: RoomAnswer;
    readonly ask: (waitSeconds: number) => Promise<RoomAnswer>;
    readonly label: string;
    readonly ceilingSeconds: number;
    readonly say: (line: string) => void;
    readonly startedAt: number;
    readonly now?: () => number;
    readonly biggest?: () => BigProcess[];
    readonly sleep?: (ms: number) => Promise<void>;
}): Promise<RoomAnswer>;
