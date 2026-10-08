import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { livePidRecord } from "@intentic/local-agent";
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
        // allow(silent-catch): no record yet is nothing to roll
        const size = (await lstat(path).catch(() => undefined))?.size ?? 0;
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
        // allow(silent-catch): no bin folder holds no half downloads
        const names = (await readdir(bin).catch((): string[] => [])).filter(isShimPart);
        const stale = await Promise.all(
            names.map(async (name) => {
                // allow(silent-catch): a file gone since the listing is nothing to prune
                const info = await lstat(join(bin, name)).catch(() => undefined);
                return info !== undefined && now - info.mtimeMs >= PART_KEEP_MS ? name : undefined;
            }),
        );
        return stale
            .filter((name): name is string => name !== undefined)
            .map((name) => ({ what: join(bin, name), act: async () => await rm(join(bin, name), { force: true }) }));
    },
};

export const RETENTION_ENTRIES: readonly UpkeepEntry[] = [trashPrune, auditRotate, shimParts];
