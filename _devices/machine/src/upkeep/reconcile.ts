import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { claimPidFile, homeDir, type Log, releasePidFile } from "@intentic/local-agent";
import { type DeviceUpkeep, DeviceUpkeepSchema, UPKEEP_SKIPPED_SHOWN } from "@intentic/sandbox-contract";
import { baseDir } from "../config.js";
import { type Rounds, startRounds } from "../device/sandbox-rounds/ic-rounds.js";
import { MACHINE_VERSION } from "../version.js";
import type { UpkeepAction, UpkeepContext, UpkeepEntry } from "./entry.js";
import { MANIFEST } from "./manifest.js";

/* THE DEVICE RECONCILER (2026-10-05). Every environment's agent runs the manifest (manifest.ts) a minute after it
   starts and every six hours after that, so a machine converges whether or not it ever restarts, and a person runs the
   same pass with `intentic-machine doctor [--fix]`. Each pass ends in one line in machine.log and in `upkeep.json`,
   which the device's facts carry to the sandboxes it is linked to (device/tools/describe.ts), so whether a release
   brought old machines to the current shape is read, not assumed. */

// A minute after start: after the claim, the keeper's first sweep and the first links, which a start is for.
export const UPKEEP_FIRST_MS = 60_000;
export const UPKEEP_EVERY_MS = 6 * 60 * 60_000;

export const upkeepPathOf = (base: string): string => join(base, "upkeep.json");
const markerOf = (base: string, entry: UpkeepEntry): string => join(base, "upkeep", entry.id);
// One pass that changes things at a time per environment, the resident's or a person's `doctor --fix`.
const lockOf = (base: string): string => join(base, "upkeep.pid");

// One thing a pass found, and what became of it: put right, put right only on `--fix` (a dry run), or left with why.
export type UpkeepOutcome = "fixed" | "would-fix" | "skipped";

export interface UpkeepItem {
    readonly id: string;
    readonly kind: string;
    readonly action: UpkeepAction;
    readonly what: string;
    readonly outcome: UpkeepOutcome;
    readonly why?: string;
}

// What upkeep.json holds: when, by which release, how many things of each kind were found and put right, and every one
// that was left, with why. DeviceUpkeep (the contract) is the same minus `version`, and at most UPKEEP_SKIPPED_SHOWN
// skipped lines.
export interface UpkeepReport extends DeviceUpkeep {
    readonly version: string;
}

const count = (items: readonly UpkeepItem[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const item of items) {
        counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    }
    return counts;
};

// Pure over the pass's items.
export const reportOf = (items: readonly UpkeepItem[], at: number, version: string): UpkeepReport => ({
    at,
    version,
    found: count(items),
    fixed: count(items.filter((item) => item.outcome === "fixed")),
    skipped: items.filter((item) => item.outcome === "skipped").map(({ kind, what, why }) => ({ kind, what, why: why ?? "" })),
});

const total = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, n) => sum + n, 0);
const byKind = (counts: Readonly<Record<string, number>>): string =>
    Object.entries(counts)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", ");

// The one line a pass leaves in machine.log. Pure.
export const summaryLine = (report: UpkeepReport, fix: boolean): string => {
    const found = total(report.found);
    if (found === 0) {
        return "upkeep: nothing left over from older releases, and every store within its bounds.";
    }
    const done = fix ? `fixed ${total(report.fixed)}` : `would fix ${found - report.skipped.length}`;
    const skipped =
        report.skipped.length === 0
            ? ""
            : `, skipped ${report.skipped.length}: ${report.skipped
                  .slice(0, 3)
                  .map((item) => `${item.what} (${item.why})`)
                  .join("; ")}${report.skipped.length > 3 ? `; and ${report.skipped.length - 3} more` : ""}`;
    return `upkeep: found ${found} (${byKind(report.found)}), ${done}${skipped}`;
};

// Whether a once-only entry is done: its own marker, or the one an earlier build wrote for the same work, which the
// first pass that fixes moves to the new name.
const done = async (entry: UpkeepEntry, context: UpkeepContext, fix: boolean): Promise<boolean> => {
    const marker = markerOf(context.base, entry);
    // allow(silent-catch): a marker that cannot be read is no marker; the entry runs, and is idempotent anyway
    if ((await readFile(marker, "utf8").catch(() => undefined)) !== undefined) {
        return true;
    }
    const former = entry.formerMarker === undefined ? undefined : join(context.base, entry.formerMarker);
    // allow(silent-catch): as above
    if (former === undefined || (await readFile(former, "utf8").catch(() => undefined)) === undefined) {
        return false;
    }
    if (fix) {
        await markDone(entry, context);
        await rm(former, { force: true });
    }
    return true;
};

const markDone = async (entry: UpkeepEntry, context: UpkeepContext): Promise<void> => {
    await mkdir(join(context.base, "upkeep"), { recursive: true, mode: 0o700 });
    await writeFile(markerOf(context.base, entry), `${new Date(context.now).toISOString()} ${MACHINE_VERSION}\n`, { mode: 0o600 });
};

// Every entry in order, each finding acted on (`fix`) or only listed. One entry that cannot look, or one finding whose
// act fails, costs that line alone: it is reported as skipped, with why, and the pass goes on. A once-only entry is
// marked done only when nothing it found was left.
export const reconcile = async (
    entries: readonly UpkeepEntry[],
    context: UpkeepContext,
    { fix }: { readonly fix: boolean },
): Promise<UpkeepItem[]> => {
    const items: UpkeepItem[] = [];
    for (const entry of entries) {
        const line = { id: entry.id, kind: entry.kind, action: entry.action };
        // oxlint-disable-next-line eslint/no-await-in-loop -- one entry at a time: two may touch the same folder
        if (entry.once === true && (await done(entry, context, fix))) {
            continue;
        }
        let found;
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            found = await entry.find(context);
        } catch (error) {
            items.push({ ...line, what: entry.id, outcome: "skipped", why: `could not look: ${errorMessage(error)}` });
            continue;
        }
        let left = false;
        for (const finding of found) {
            if (finding.act === undefined) {
                items.push({ ...line, what: finding.what, outcome: "skipped", why: finding.why ?? "left as it is" });
                left = true;
            } else if (!fix) {
                items.push({ ...line, what: finding.what, outcome: "would-fix" });
                left = true;
            } else {
                try {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- in order, as found
                    await finding.act();
                    items.push({ ...line, what: finding.what, outcome: "fixed" });
                } catch (error) {
                    items.push({ ...line, what: finding.what, outcome: "skipped", why: errorMessage(error) });
                    left = true;
                }
            }
        }
        if (fix && entry.once === true && !left) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await markDone(entry, context);
        }
    }
    return items;
};

export interface UpkeepRun {
    readonly report: UpkeepReport;
    readonly items: readonly UpkeepItem[];
}

export interface UpkeepOptions {
    readonly fix: boolean;
    readonly resident: boolean;
    readonly supervisor: string | undefined;
    readonly log: Log;
    readonly entries?: readonly UpkeepEntry[];
    readonly home?: string;
    readonly base?: string;
    readonly now?: number;
    readonly platform?: NodeJS.Platform;
}

// One pass. A pass that changes things holds this environment's upkeep lock and writes upkeep.json; a dry run does
// neither. Answers the holder's pid instead when another pass that changes things is running.
export const runUpkeep = async (options: UpkeepOptions): Promise<UpkeepRun | { readonly busy: number }> => {
    const base = options.base ?? baseDir;
    const context: UpkeepContext = {
        log: options.log,
        now: options.now ?? Date.now(),
        home: options.home ?? homeDir(),
        base,
        platform: options.platform ?? process.platform,
        supervisor: options.supervisor,
        resident: options.resident,
    };
    if (options.fix) {
        const claim = await claimPidFile(lockOf(base), base, { pid: process.pid, build: MACHINE_VERSION });
        if (!claim.claimed) {
            return { busy: claim.holder.pid };
        }
    }
    try {
        const items = await reconcile(options.entries ?? MANIFEST, context, { fix: options.fix });
        const report = reportOf(items, context.now, MACHINE_VERSION);
        if (options.fix) {
            await writeFileAtomic(upkeepPathOf(base), `${JSON.stringify(report, undefined, 2)}\n`, 0o600);
        }
        return { report, items };
    } finally {
        if (options.fix) {
            await releasePidFile(lockOf(base), process.pid);
        }
    }
};

// What the device's facts carry of the last pass (contract: DeviceUpkeepSchema): its counts and the first skipped lines.
// Undefined before the first pass, or for a file this build cannot read.
export const readUpkeepSummary = async (base: string = baseDir): Promise<DeviceUpkeep | undefined> => {
    // allow(silent-catch): no file yet is no pass yet, which the facts leave out
    const text = await readFile(upkeepPathOf(base), "utf8").catch(() => undefined);
    if (text === undefined) {
        return undefined;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        // allow(silent-catch): a torn file is no reading; the next pass writes it whole
        return undefined;
    }
    const parsed = DeviceUpkeepSchema.safeParse(raw);
    return parsed.success ? { ...parsed.data, skipped: parsed.data.skipped.slice(0, UPKEEP_SKIPPED_SHOWN) } : undefined;
};

// The resident's clock: a pass a minute after start, then every six hours, in every environment.
export const startUpkeep = (log: Log, supervisor: string | undefined): Rounds =>
    startRounds(
        "upkeep",
        log,
        UPKEEP_FIRST_MS,
        () => UPKEEP_EVERY_MS,
        async () => {
            const run = await runUpkeep({ fix: true, resident: true, supervisor, log });
            log("busy" in run ? `upkeep: skipped this pass, a \`doctor --fix\` is running (pid ${run.busy}).` : summaryLine(run.report, true));
        },
    );
