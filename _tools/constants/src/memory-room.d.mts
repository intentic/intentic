// Types for memory-room.mjs, the one room formula the daemon's ResourceBudget and the scripts share.
export type RoomWorkload = "agentRuntime" | "service" | "panel" | "install" | "command" | "toolchain";

export const COST_BYTES: Readonly<Record<RoomWorkload, number>>;
export const PERSON_RESERVE_BYTES: number;
export const STALL_PERCENT: number;
export const RESERVATION_MS: number;
export const ROOM_SOCKET: string;
export const READING_FILES: readonly string[];

export interface MemoryReading {
    // memory.high, else memory.max, else the machine's memory; undefined where nothing bounds it.
    readonly limitBytes: number | undefined;
    // Working set plus swap; undefined where nothing measures it.
    readonly usedBytes: number | undefined;
    // The swapped part of `usedBytes`; 0 when swap is off or unaccounted.
    readonly swapBytes: number;
    // The machine's MemAvailable, which free memory never exceeds; absent where the machine does not say.
    readonly availableBytes?: number | undefined;
    // Memory PSI `full avg10`, in percent; 0 when healthy or unreported.
    readonly stallPercent: number;
    // memory.events `oom_kill`, cumulative; undefined without a cgroup.
    readonly oomKills: number | undefined;
}

export interface ShortMemory {
    readonly limitBytes: number;
    readonly residentBytes: number;
    readonly swapBytes: number;
}

export type RoomVerdict = "run" | "wait" | "refuse";

export interface RoomJudgement {
    readonly verdict: RoomVerdict;
    readonly needBytes: number;
    readonly freeBytes: number | undefined;
    readonly reservedBytes: number;
    // Why the sandbox is short; absent on `run`.
    readonly diagnosis?: string;
    // The reading a byte shortfall was decided on; absent on a stall, whose ceiling is not what is wrong.
    readonly memory?: ShortMemory;
}

export interface RoomAnswer extends RoomJudgement {
    readonly waitedMs: number;
    readonly source: "daemon" | "formula";
}

export function readingFrom(read: (path: string) => string | undefined): MemoryReading;
export function readReadingSync(): MemoryReading;
export function needBytes(workload: RoomWorkload, attended: boolean): number;
export function judge(reading: MemoryReading, request: { readonly workload: RoomWorkload; readonly attended: boolean; readonly reservedBytes?: number }): RoomJudgement;
export function freeBytesOf(reading: MemoryReading): number | undefined;
export function askRoom(options?: {
    readonly workload?: RoomWorkload;
    readonly waitSeconds?: number;
    readonly label?: string;
    readonly socketPath?: string;
    readonly intervalMs?: number;
    readonly read?: () => MemoryReading;
}): Promise<RoomAnswer>;
export function askFree(options?: { readonly socketPath?: string; readonly read?: () => MemoryReading }): Promise<{
    readonly freeBytes: number | undefined;
    readonly source: "daemon" | "formula";
}>;
export function askFreeSync(options?: { readonly socketPath?: string }): number | undefined;
