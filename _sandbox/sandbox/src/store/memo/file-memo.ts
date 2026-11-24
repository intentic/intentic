import { readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { errnoCode, errorMessage, isMissing, undefinedIfMissing } from "@intentic/base/errors";

// What a reader made of a file, held for as long as the file provably has not changed, so a file read many times a
// minute is read, parsed and validated once. "Provably" is the file's identity as stat reports it (device, inode, size,
// and the modification and change times to the nanosecond), with git's rule for racy timestamps on top:
// - a filesystem stamps a change with a clock coarser than its nanosecond field (a jiffy on Linux, 2 s on FAT, a
//   server's clock over SMB), so a rewrite inside the same tick as the change a memo was made from can leave every
//   field equal. A memo therefore answers alone only once it was confirmed at a moment RACY_MS past the file's newest
//   timestamp: any write after that moment stamps a later time. Until then a read still reads the bytes and compares
//   them with the ones the memo was made from, which costs the read but not the parse.
// - the change time (ctime) is in the identity and in that rule because no writer can set it: a rewrite that restores
//   the old mtime (`touch -d`, `cp -p`, an extract) still moves it.
// - an atomic write renames a new inode over the name, so a write by another handle or process is a new identity even
//   when an inode number comes back round, since it then carries a newer change time.

// Past the coarsest timestamp a filesystem the daemon reads may use (FAT's 2 s) with a margin for a server's clock.
export const RACY_MS = 3_000;

// The wall clock as it was when this module loaded: a suite's fake timers replace `Date`, and a clock set ahead would
// otherwise vouch for a memo inside the very tick a rewrite could hide in. A suite about the memo itself moves it on
// past the window instead of waiting it out.
export const memoClock = { now: Date.now };

// One look at the file: its identity, its newest timestamp in milliseconds, and when the look began.
export interface Sighting {
    readonly identity: string;
    readonly changedMs: number;
    readonly at: number;
}

export interface Memo<V> {
    readonly identity: string;
    readonly changedMs: number;
    // Whether the identity alone answers for the file; while it does not, `bytes` are what the memo was made from.
    readonly settled: boolean;
    readonly bytes: string | undefined;
    readonly value: V;
}

const sightingOf = (stats: BigIntStats, at: number): Sighting => ({
    identity: `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeNs)}:${String(stats.ctimeNs)}`,
    changedMs: Number((stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs) / 1_000_000n),
    at,
});

// Undefined for an absent file; any other failure throws, for the caller's own read to meet and report.
const sight = async (path: string): Promise<Sighting | undefined> => {
    // Taken before the stat, so the moment can only be earlier than the bytes read after it.
    const at = memoClock.now();
    const stats = await stat(path, { bigint: true }).catch(undefinedIfMissing);
    return stats === undefined ? undefined : sightingOf(stats, at);
};

// A memo of `value`, made from `bytes` as they stood at `sighting` (read after it).
export const memoOf = <V>(sighting: Sighting, bytes: string, value: V): Memo<V> => {
    const settled = sighting.at - sighting.changedMs > RACY_MS;
    return { identity: sighting.identity, changedMs: sighting.changedMs, settled, bytes: settled ? undefined : bytes, value };
};

// What a memo says about the file now: its value stands without a read, stands only if the bytes still match, or not.
export const standing = <V>(memo: Memo<V> | undefined, sighting: Sighting): "fresh" | "confirm" | "stale" => {
    if (memo?.identity !== sighting.identity) {
        return "stale";
    }
    return memo.settled ? "fresh" : "confirm";
};

// The memo once a read at `sighting` found the bytes it was made from: settled if that read was late enough to vouch.
export const confirmed = <V>(memo: Memo<V>, sighting: Sighting, bytes: string): Memo<V> | undefined =>
    memo.bytes === bytes ? memoOf(sighting, bytes, memo.value) : undefined;

// Freezes plain objects and arrays all the way down, so a value handed to every reader of a memo cannot be changed by
// one of them under the others; anything else (a Date, a Map, a buffer) is left as it is.
// What a store's parse makes: objects and arrays of them, any of which may be one a reader holds.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- walks whatever any store's parse returns, by design of no one shape
type Branch = Readonly<Record<string, unknown>> | readonly unknown[];

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the guard that narrows a parse's output to a branch
const isBranch = (value: unknown): value is Branch => Object(value) === value;

const freeze = (branch: Branch): void => {
    // Already frozen: its children were frozen with it.
    if (Object.isFrozen(branch)) {
        return;
    }
    // Functions and class instances carry their own prototype, and are left alone with it.
    const proto: unknown = Object.getPrototypeOf(branch);
    if (!Array.isArray(branch) && proto !== Object.prototype && proto !== null) {
        return;
    }
    Object.freeze(branch);
    for (const child of Object.values(branch)) {
        if (isBranch(child)) {
            freeze(child);
        }
    }
};

export const deepFreeze = <V>(value: V): V => {
    if (isBranch(value)) {
        freeze(value);
    }
    return value;
};

// Where one reader keeps its memo of one file.
export interface MemoCell<V> {
    memo: Memo<V> | undefined;
}

export interface MemoReader<V> {
    // The file is absent, by its stat or by its read.
    readonly absent: () => V;
    // It exists but its bytes could not be read, for the reason given (an errno code where there is one).
    readonly failed: (reason: string) => V;
    // What its bytes read as; the one step a memo spares. A throw passes to the caller and is held by nothing.
    readonly interpret: (bytes: string) => Promise<V> | V;
}

// One read of `path` through `cell`: the held value while the file provably has not changed, else the bytes read and
// interpreted and held for next time. Only an interpreted reading is held; absence and a failed read are asked again.
export const readThrough = async <V>(cell: MemoCell<V>, path: string, reader: MemoReader<V>): Promise<V> => {
    // allow(silent-catch): a stat refused other than by absence is left to the read below, which meets and reports it
    const sighting = await sight(path).catch(() => null);
    if (sighting === undefined) {
        cell.memo = undefined;
        return reader.absent();
    }
    const held = cell.memo;
    const now = held === undefined || sighting === null ? "stale" : standing(held, sighting);
    if (held !== undefined && now === "fresh") {
        return held.value;
    }
    let bytes: string;
    try {
        bytes = await readFile(path, "utf8");
    } catch (error) {
        cell.memo = undefined;
        return isMissing(error) ? reader.absent() : reader.failed(errnoCode(error) ?? errorMessage(error));
    }
    const kept = held !== undefined && sighting !== null && now === "confirm" ? confirmed(held, sighting, bytes) : undefined;
    if (kept !== undefined) {
        cell.memo = kept;
        return kept.value;
    }
    cell.memo = undefined;
    const value = await reader.interpret(bytes);
    cell.memo = sighting === null ? undefined : memoOf(sighting, bytes, value);
    return value;
};

// After the reader itself wrote `bytes` to `path`: what they read as is held, so its next read needs no parse.
export const heldAfterWrite = async <V>(cell: MemoCell<V>, path: string, bytes: string, interpret: (bytes: string) => Promise<V> | V): Promise<void> => {
    cell.memo = undefined;
    const sighting = await sight(path).catch(undefinedIfMissing);
    if (sighting === undefined) {
        return;
    }
    try {
        cell.memo = memoOf(sighting, bytes, await interpret(bytes));
    } catch {
        // allow(silent-catch): the write landed; bytes that do not read back are left for the next read to meet and report
    }
};
