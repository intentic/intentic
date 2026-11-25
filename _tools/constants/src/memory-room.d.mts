// Types for memory-room.mjs, the one room formula the daemon's ResourceBudget and the scripts share.
import type { CommandSignature, LearnedPrice } from "./heavy/command-peaks.mjs";

export type { LearnedPrice } from "./heavy/command-peaks.mjs";
export type RoomWorkload = "agentRuntime" | "service" | "panel" | "install" | "command" | "toolchain";

export const COST_BYTES: Readonly<Record<RoomWorkload, number>>;
export const PERSON_RESERVE_BYTES: number;
export const TARGETED_RUN_BYTES: number;
// A toolchain command priced by its named shape instead of its class's cost (SIZE_BYTES): one aimed at named files,
// the editor's full typecheck, a changed-files Vue typecheck, a Cargo build; or by MiB (`6144m`), what a project
// declares its own heavy command holds.
export type NamedRoomSize = "targeted" | "editor-typecheck" | "scoped-typecheck" | "cargo-build";
export type RoomSize = NamedRoomSize | `${number}m`;
export const SIZE_BYTES: Readonly<Record<NamedRoomSize, number>>;
export function isRoomSize(size: string): size is RoomSize;
export const TEST_PROCESS_BYTES: Readonly<{ fanOutWorker: number; standaloneWorker: number; typecheck: number; ceiling: number }>;
export const STALL_PERCENT: number;
export const STALL_SUSTAINED_PERCENT: number;
export const IO_STALL_PERCENT: number;
export const IO_STALL_SUSTAINED_PERCENT: number;
export const SWAP_FULL_SHARE: number;
export const RESERVATION_MS: number;
export const ROOM_SOCKET: string;
export const READING_FILES: readonly string[];

export interface MemoryReading {
    // memory.high, else memory.max, else the machine's memory; undefined where nothing bounds it. Never above the workload
    // leaf's memory.max plus what runs outside that leaf, where the leaf is bounded: admitted work runs in the leaf.
    readonly limitBytes: number | undefined;
    // Working set plus swap; undefined where nothing measures it. Free memory is counted against its resident part.
    readonly usedBytes: number | undefined;
    // The swapped part of `usedBytes`; 0 when swap is off or unaccounted.
    readonly swapBytes: number;
    // What swap can hold: memory.swap.max, never more than what is swapped plus the machine's SwapFree, nor than the
    // workload leaf's memory.swap.max plus what is swapped outside it; at a root cgroup the machine's SwapTotal.
    // Undefined where nothing bounds it. Past SWAP_FULL_SHARE of it, swap counts as used.
    readonly swapLimitBytes?: number | undefined;
    // The machine's MemAvailable, which free memory never exceeds; absent where the machine does not say.
    readonly availableBytes?: number | undefined;
    // Memory PSI `full avg10`, in percent; 0 when healthy or unreported.
    readonly stallPercent: number;
    // Memory PSI `full avg60`, in percent, from the same file; 0 when healthy or unreported.
    readonly stallSustainedPercent?: number | undefined;
    // IO PSI `full avg10` and `avg60`, in percent: the cgroup's, else the machine's; 0 when healthy or unreported.
    readonly ioStallPercent?: number | undefined;
    readonly ioStallSustainedPercent?: number | undefined;
    // memory.events `oom_kill`, cumulative; undefined without a cgroup.
    readonly oomKills: number | undefined;
    // (2026-11-02) The machine this sandbox runs on, as its agent last said, added by the daemon only while that is
    // fresh; absent is "no host to answer to", never "no room". Work nobody waits on waits while it would take the host
    // under `reserveBytes`.
    readonly host?: HostRoom | undefined;
}

export interface HostRoom {
    // The machine's name as the owner knows it (its device card), for the sentence a held command is given.
    readonly name: string;
    readonly availableBytes: number;
    readonly totalBytes: number;
    readonly reserveBytes: number;
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
    // Why a held command waited: the first short reading's diagnosis.
    readonly waitedFor?: string;
    // The wait was given up before its deadline, since waiting could not help (stuckWait).
    readonly stuck?: boolean;
    // Held to its ceiling below the floor (heavy/memory-floor.mjs): the command must not start.
    readonly notStarted?: boolean;
    // The daemon's answer only: what it priced the command at, and, where that is the command's measured peak rather
    // than its rule's price, why (learnedCostBytes).
    readonly costBytes?: number;
    readonly priced?: LearnedPrice;
}

export const STUCK_MS: number;
export const EASED_BYTES: number;
export function stuckWait(options?: { readonly stuckMs?: number; readonly easedBytes?: number }): {
    readonly observe: (judged: Pick<RoomJudgement, "freeBytes" | "reservedBytes">, at: number) => boolean;
};
export { LEARNED_MIN_BYTES, LEARNED_RULE, learnedCostBytes, lineSignature, PEAK_MARGIN, peakWords } from "./heavy/command-peaks.mjs";
export { waitWords } from "./heavy/memory-floor.mjs";

export function readingFrom(read: (path: string) => string | undefined): MemoryReading;
export function readReadingSync(): MemoryReading;
export function costBytesOf(workload: RoomWorkload, size?: RoomSize): number;
export function needBytes(workload: RoomWorkload, attended: boolean, size?: RoomSize, costBytes?: number): number;
export function judge(
    reading: MemoryReading,
    request: {
        readonly workload: RoomWorkload;
        readonly attended: boolean;
        readonly reservedBytes?: number;
        readonly size?: RoomSize | undefined;
        // What this one takes, where the caller learned it (an agent's envelope), instead of its class's or size's price.
        readonly costBytes?: number | undefined;
    },
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
    // The command `pid` runs and that process's start (heavy/command-peaks.mjs queuedSignature).
    readonly signature?: CommandSignature & { readonly start: number };
    // How long a wait that cannot help is kept up before it is given up (STUCK_MS).
    readonly stuckMs?: number;
}): Promise<RoomAnswer>;
export function askFree(options?: { readonly socketPath?: string; readonly read?: () => MemoryReading }): Promise<{
    readonly freeBytes: number | undefined;
    readonly source: "daemon" | "formula";
}>;
export function askFreeSync(options?: { readonly socketPath?: string }): number | undefined;
