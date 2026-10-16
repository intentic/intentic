import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { readTextIfExists } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";
import { livePidRecord } from "@intentic/local-agent";
import { z } from "zod";
import { AUDIT_ROLL_BYTES, rollAudit } from "../device/audit.js";
import type { Finding, UpkeepEntry } from "./entry.js";
import { trashDirOf, trashedAt } from "./trash.js";

/* WHAT THIS AGENT KEEPS, AND FOR HOW LONG. Every store says its retention where it is kept (rule 5 of the 2026-10
   self-healing audit), and this is the one clock that enforces it on a device. */

// How long something stays in this agent's trash, from the day it went there: long enough for a person who misses a
// folder to come looking. omen held 169 MB there from 2026-09-25 with no end.
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60_000;

// The trash entries past their keeping, oldest first, and the ones whose name carries no date, which are never guessed
// at. Pure over the names.
export const expiredTrash = (names: readonly string[], now: number): { readonly expired: readonly string[]; readonly undated: readonly string[] } => {
    const dated = names.map((name) => ({ name, at: trashedAt(name) }));
    return {
        expired: dated
            .filter(({ at }) => at !== undefined && now - at >= TRASH_KEEP_MS)
            .toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0))
            .map(({ name }) => name),
        undated: dated.filter(({ at }) => at === undefined).map(({ name }) => name),
    };
};

const trashPrune: UpkeepEntry = {
    id: "machine-trash",
    kind: "trash",
    action: "prune",
    reason: "what went into this agent's trash (trash_file, and the upkeep's own moves) more than 30 days ago",
    find: async ({ base, now }) => {
        const trash = trashDirOf(base);
        // allow(silent-catch): no trash folder is an empty trash
        const { expired, undated } = expiredTrash(await readdir(trash).catch((): string[] => []), now);
        return [
            ...expired.map((name): Finding => ({
                what: join(trash, name),
                act: async () => await rm(join(trash, name), { recursive: true, force: true }),
            })),
            ...undated.map((name): Finding => ({
                what: join(trash, name),
                why: "its name carries no date, so how long it has been there is not known",
            })),
        ];
    },
};

const auditRotate: UpkeepEntry = {
    id: "audit-log",
    kind: "log",
    action: "rotate",
    reason: `the record of every call agents made here, set aside as audit.jsonl.1 once it reaches ${AUDIT_ROLL_BYTES / 1024 / 1024} MB`,
    find: async ({ base }) => {
        const path = join(base, "audit.jsonl");
        // No record yet is nothing to roll.
        const size = (await lstat(path).catch(undefinedIfMissing))?.size ?? 0;
        return size < AUDIT_ROLL_BYTES ? [] : [{ what: path, act: async () => void (await rollAudit(path)) }];
    },
};

// A half download is resumed by the shim that started it, the same day; one a day old belongs to an install nobody
// finished. The shims name them `<binary>.part-<release>` or `<binary>.part` (device.sh, sync.sh), which bin/'s own sweep
// keeps on purpose (release.ts, isLeftover).
export const PART_KEEP_MS = 24 * 60 * 60_000;
export const isShimPart = (name: string): boolean => /\.part(?:-[^/\\]+)?$/.test(name);

const shimParts: UpkeepEntry = {
    id: "bin-part-files",
    kind: "download",
    action: "prune",
    reason: "half downloads of this agent the install command left in its bin folder more than a day ago",
    find: async ({ base, now }) => {
        const bin = join(base, "bin");
        // An upgrade running now may be resuming one of them.
        if ((await livePidRecord(join(bin, "upgrade.lock"))) !== undefined) {
            return [];
        }
        // No bin folder holds no half downloads.
        const names = ((await readdir(bin).catch(undefinedIfMissing)) ?? []).filter(isShimPart);
        const stale = await Promise.all(
            names.map(async (name) => {
                // A file gone since the listing is nothing to prune.
                const info = await lstat(join(bin, name)).catch(undefinedIfMissing);
                return info !== undefined && now - info.mtimeMs >= PART_KEEP_MS ? name : undefined;
            }),
        );
        return stale
            .filter((name): name is string => name !== undefined)
            .map((name) => ({ what: join(bin, name), act: async () => await rm(join(bin, name), { force: true }) }));
    },
};

/* WHAT app_start's PROGRAMS PRINTED (2026-10-11). Each run's output is a file (or, for one run in Windows Sandbox, a
   folder) under `runs/<sandbox>/.logs`, and nothing ever removed one: apps.json forgets all but the last 30 runs, but
   their logs stayed. An output is kept for two weeks and at most the newest hundred per sandbox are; the output of a
   run apps.json still holds as running is never touched, whatever its age. */
export const RUN_LOG_KEEP_MS = 14 * 24 * 60 * 60_000;
export const RUN_LOGS_KEPT = 100;

// The entries of one `.logs` folder to delete, oldest first: past their keeping, or past the newest RUN_LOGS_KEPT, and
// never one named in `live`. Pure over names and times.
export const expiredRunLogs = (entries: readonly { readonly name: string; readonly mtimeMs: number }[], live: ReadonlySet<string>, now: number): string[] => {
    const newestFirst = entries.filter(({ name }) => !live.has(name)).toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    return newestFirst
        .filter((entry, index) => index >= RUN_LOGS_KEPT || now - entry.mtimeMs >= RUN_LOG_KEEP_MS)
        .toReversed()
        .map(({ name }) => name);
};

// What apps.json says of a run, as far as pruning reads it (programs.ts writes the whole AppRun).
const RunRecordsSchema = z.array(z.object({ log: z.string(), endedAt: z.string().optional() }).loose());

// The `.logs` entries of the runs one sandbox's apps.json holds as running: a run's own log file, or the folder an
// isolated run's log sits in. A record that does not read protects nothing, so the caller prunes nothing of that sandbox.
const liveRunLogs = async (sandboxDir: string): Promise<ReadonlySet<string> | undefined> => {
    // No record at all is a sandbox that never started a program here.
    const text = (await readTextIfExists(join(sandboxDir, "apps.json"))) ?? "[]";
    // A record torn mid-write cannot say what runs, so nothing of this sandbox is pruned this pass.
    const runs = parseJsonWith(text, RunRecordsSchema);
    if (runs === undefined) {
        return undefined;
    }
    const logs = join(sandboxDir, ".logs");
    return new Set(runs.filter((run) => run.endedAt === undefined).map((run) => (dirname(run.log) === logs ? basename(run.log) : basename(dirname(run.log)))));
};

const runLogs: UpkeepEntry = {
    id: "app-run-logs",
    kind: "log",
    action: "prune",
    reason: `what programs started with app_start printed, kept ${RUN_LOG_KEEP_MS / 86_400_000} days and at most the newest ${RUN_LOGS_KEPT} per sandbox`,
    find: async ({ base, now }) => {
        const runs = join(base, "runs");
        // allow(silent-catch): no runs folder is a device no sandbox ever started a program on
        const sandboxes = await readdir(runs).catch((): string[] => []);
        const found = await Promise.all(
            sandboxes.map(async (sandbox): Promise<Finding[]> => {
                const logs = join(runs, sandbox, ".logs");
                const live = await liveRunLogs(join(runs, sandbox));
                // A sandbox folder with no outputs has nothing to prune.
                const names = live === undefined ? [] : ((await readdir(logs).catch(undefinedIfMissing)) ?? []);
                const entries = await Promise.all(
                    names.map(async (name) => {
                        // An output gone since the listing is nothing to prune.
                        const info = await lstat(join(logs, name)).catch(undefinedIfMissing);
                        return info === undefined ? undefined : { name, mtimeMs: info.mtimeMs };
                    }),
                );
                const known = entries.filter((entry) => entry !== undefined);
                return expiredRunLogs(known, live ?? new Set(), now).map((name) => ({
                    what: join(logs, name),
                    act: async () => await rm(join(logs, name), { recursive: true, force: true }),
                }));
            }),
        );
        return found.flat();
    },
};

export const RETENTION_ENTRIES: readonly UpkeepEntry[] = [trashPrune, auditRotate, shimParts, runLogs];
