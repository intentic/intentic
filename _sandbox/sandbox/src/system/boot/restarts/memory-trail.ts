import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import type { z } from "zod";
import {
    MEMORY_KILLS_FILE,
    type MemoryKill,
    MemoryKillSchema,
    NETD_KILLS_FILE,
    type NetdKill,
    NetdKillSchema,
    parseLines,
    PRESSURE_FILE,
    type PressureSample,
    PressureSampleSchema,
} from "../../resources/memory-records.js";

/* THE MEMORY TRAIL A STOP LEAVES, READ BACK AT THE NEXT BOOT (2026-11-05). netd writes what it killed and what it did to
   the daemon, and its samples while memory is short; the daemon writes what the kernel killed inside the sandbox's own
   bound (memory-records.ts names the three files). They are read at boot, synchronously, before anything else runs
   (boot-marker.ts files the post-mortem on the restart record as it claims the exit marker), so each read is bounded:
   only the newest TAIL_BYTES of a file, and the rotated `<file>.1` before it, are read. A line a kill tore mid-write is
   skipped by parseLines; a file that is not there is an empty trail; one that cannot be read is an empty trail with the
   reason, for the post-mortem to say. */

// A day of pressure samples at one every few seconds is a few MiB; a post-mortem reaches back one restart chain, so the
// newest few MiB of each file are what it can use.
const TAIL_BYTES = 4 * 1024 * 1024;

export interface Trail<T> {
    readonly rows: readonly T[];
    // Why a file that is there could not be read.
    readonly unreadable?: string;
}

// The newest `maxBytes` of a file, from the first whole line in them; undefined for a file that is not there.
const tailOf = (path: string, maxBytes: number): string | undefined => {
    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const got = readSync(fd, buffer, read, length - read, size - length + read);
            if (got === 0) {
                break;
            }
            read += got;
        }
        const text = buffer.toString("utf8", 0, read);
        // Started mid-file: the first line is a fragment of one before it.
        return size > length ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
        closeSync(fd);
    }
};

/** The rows of `<file>.1` then `<file>` under `logsDir` that parse as `schema`, oldest first. Never throws. */
export const readTrail = <T>(logsDir: string, file: string, schema: z.ZodType<T>): Trail<T> => {
    const rows: T[] = [];
    const problems: string[] = [];
    for (const name of [`${file}.1`, file]) {
        try {
            rows.push(...parseLines(tailOf(join(logsDir, name), TAIL_BYTES) ?? "", schema));
        } catch (error) {
            problems.push(`${name}: ${errnoCode(error) ?? errorMessage(error)}`);
        }
    }
    return problems.length === 0 ? { rows } : { rows, unreadable: problems.join("; ") };
};

/** The three records, as far as the files reach. */
export interface MemoryTrail {
    readonly kills: Trail<MemoryKill>;
    readonly netd: Trail<NetdKill>;
    readonly pressure: Trail<PressureSample>;
}

export const readMemoryTrail = (logsDir: string): MemoryTrail => ({
    kills: readTrail(logsDir, MEMORY_KILLS_FILE, MemoryKillSchema),
    netd: readTrail(logsDir, NETD_KILLS_FILE, NetdKillSchema),
    pressure: readTrail(logsDir, PRESSURE_FILE, PressureSampleSchema),
});

/* BOOTS THAT NEVER FINISHED STARTING. */

// netd's HELLO_DEADLINE (_sandbox/netd/crates/netd/src/vitals.rs): how long a started daemon has to say hello before netd
// kills it. A `no-hello` kill without its own `silentMs` is taken to have waited this long.
export const NO_HELLO_DEADLINE_MS = 3 * 60_000;
// A boot is recorded a moment after netd spawned it (the process loads, then prepareDaemonProcess records it): this much
// earlier than the spawn netd dates still reads as the same daemon, for clocks rounded to the millisecond or stepped.
const SPAWN_SLACK_MS = 5_000;

/**
 * The boots (epoch ms, as boot-history.json keeps them) that never finished starting: netd killed the daemon it had
 * started for not saying hello (`no-hello` in netd-kills.jsonl). Such a kill belongs to the newest boot before it, if
 * that boot came after netd spawned the daemon it killed (the kill's time less how long it waited); an older one is a
 * boot before it, and the daemon netd killed never got as far as recording its own.
 */
export const neverStartedBoots = (boots: readonly number[], kills: readonly NetdKill[]): ReadonlySet<number> => {
    const sorted = boots.toSorted((a, b) => a - b);
    const never = new Set<number>();
    for (const kill of kills) {
        if (kill.kind !== "no-hello") {
            continue;
        }
        const boot = sorted.findLast((at) => at <= kill.at);
        const spawnedAt = kill.at - (kill.silentMs ?? NO_HELLO_DEADLINE_MS);
        if (boot !== undefined && boot >= spawnedAt - SPAWN_SLACK_MS) {
            never.add(boot);
        }
    }
    return never;
};
