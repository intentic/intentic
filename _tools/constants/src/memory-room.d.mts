// Types for memory-room.mjs, the one room formula the daemon's ResourceBudget and the scripts share.
export type RoomWorkload = "agentRuntime" | "service" | "panel" | "install" | "command" | "toolchain";

export const COST_BYTES: Readonly<Record<RoomWorkload, number>>;
export const PERSON_RESERVE_BYTES: number;
export const TARGETED_RUN_BYTES: number;
// A toolchain command aimed at named files, priced at TARGETED_RUN_BYTES instead of its class's cost.
export type RoomSize = "targeted";
export const TEST_PROCESS_BYTES: Readonly<{ fanOutWorker: number; standaloneWorker: number; typecheck: number; ceiling: number }>;
export const STALL_PERCENT: number;
export const STALL_SUSTAINED_PERCENT: number;
export const SWAP_FULL_SHARE: number;
export const RESERVATION_MS: number;
export const ROOM_SOCKET: string;
export const READING_FILES: readonly string[];

export interface MemoryReading {
    // memory.high, else memory.max, else the machine's memory; undefined where nothing bounds it.
    readonly limitBytes: number | undefined;
    // Working set plus swap; undefined where nothing measures it. Free memory is counted against its resident part.
    readonly usedBytes: number | undefined;
    // The swapped part of `usedBytes`; 0 when swap is off or unaccounted.
    readonly swapBytes: number;
    // What swap can hold: memory.swap.max, never more than what is swapped plus the machine's SwapFree; at a root cgroup
    // the machine's SwapTotal. Undefined where nothing bounds it. Past SWAP_FULL_SHARE of it, swap counts as used.
    readonly swapLimitBytes?: number | undefined;
    // The machine's MemAvailable, which free memory never exceeds; absent where the machine does not say.
    readonly availableBytes?: number | undefined;
    // Memory PSI `full avg10`, in percent; 0 when healthy or unreported.
    readonly stallPercent: number;
    // Memory PSI `full avg60`, in percent, from the same file; 0 when healthy or unreported.
    readonly stallSustainedPercent?: number | undefined;
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
export function costBytesOf(workload: RoomWorkload, size?: RoomSize): number;
export function needBytes(workload: RoomWorkload, attended: boolean, size?: RoomSize): number;
export function judge(
    reading: MemoryReading,
    request: { readonly workload: RoomWorkload; readonly attended: boolean; readonly reservedBytes?: number; readonly size?: RoomSize | undefined },
): RoomJudgement;
export function freeBytesOf(reading: MemoryReading): number | undefined;
export function swapFullOf(reading: MemoryReading): boolean;
export function countedBytesOf(reading: MemoryReading): number | undefined;
export function askRoom(options?: {
    readonly workload?: RoomWorkload;
    readonly waitSeconds?: number;
    readonly label?: string;
    readonly socketPath?: string;
    readonly intervalMs?: number;
    readonly read?: () => MemoryReading;
    readonly size?: RoomSize;
    readonly pid?: number;
}): Promise<RoomAnswer>;
export function askFree(options?: { readonly socketPath?: string; readonly read?: () => MemoryReading }): Promise<{
    readonly freeBytes: number | undefined;
    readonly source: "daemon" | "formula";
}>;
export function askFreeSync(options?: { readonly socketPath?: string }): number | undefined;
