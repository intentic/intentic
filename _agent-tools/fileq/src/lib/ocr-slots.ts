import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { runBounded, type ProcessResult, type RunOptions } from "@intentic/base/process";
import { onPath } from "./tools.js";

// How many OCR readers run at once on this machine, across every process: each holds about 1.5 GiB of models and four
// threads, and fileq is started by many callers at once. ripgrep runs its preprocessor for twelve documents in
// parallel, so `rg` over a folder of unread scans started six readers (7 GiB) at once, and all six then ran past their
// time limit (measured 2026-11-23). The daemon's shadow keeper, its document routes and agents' own reads add more.
// The slots are flock(1) locks on files in /tmp, which every process here shares and the kernel releases however the
// holder ends. Without flock (macOS, a bare image) a run takes no slot, as before.

const CORES_PER_SLOT = 8;
const BYTES_PER_SLOT = 8 * 1024 ** 3;
const MAX_SLOTS = 2;
// flock's answer when the lock is held; the OCR command's own exits are 0, 1 and 2.
const BUSY = 75;
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 2_000;

/** One slot per eight cores and per 8 GiB, at least one and at most two. */
export const ocrSlotCount = (cores: number = availableParallelism(), memoryBytes: number = totalmem()): number =>
    Math.max(1, Math.min(MAX_SLOTS, Math.floor(cores / CORES_PER_SLOT), Math.floor(memoryBytes / BYTES_PER_SLOT)));

export interface SlotOptions extends RunOptions {
    readonly slots?: number;
    /** Where the lock files live; /tmp unless a test says otherwise. */
    readonly lockDir?: string;
}

const lockDirOf = (options: SlotOptions): string => options.lockDir ?? (process.platform === "win32" ? tmpdir() : "/tmp");

/**
 * `command args` run while holding one of the machine's OCR slots, waiting while every slot is held. `flock --no-fork`
 * execs the command in its own place, so the command holds the lock itself and the time limit counts from the moment
 * it has one. The command must not exit 64 or above: those are flock's own answers.
 */
export const runInOcrSlot = async (command: string, args: readonly string[], options: SlotOptions = {}): Promise<ProcessResult> => {
    if (!onPath("flock")) {
        return runBounded(command, args, options);
    }
    const slots = options.slots ?? ocrSlotCount();
    const dir = lockDirOf(options);
    for (let wait = POLL_FIRST_MS; ; wait = Math.min(wait * 2, POLL_MAX_MS)) {
        for (let slot = 0; slot < slots; slot++) {
            const lock = join(dir, `fileq-ocr-${String(slot)}.lock`);
            const result = await runBounded("flock", ["--no-fork", "--nonblock", "--conflict-exit-code", String(BUSY), lock, command, ...args], options);
            if (result.exitCode === BUSY) {
                continue;
            }
            // A lock file flock could not open or lock (a read-only /tmp, another user's file) costs the slot, not the run.
            if (result.exitCode !== null && result.exitCode >= 64 && result.stdout.text === "") {
                return runBounded(command, args, options);
            }
            // An aborted run never starts, and comes back here as itself.
            return result;
        }
        await sleep(wait, { signal: options.signal });
    }
};
