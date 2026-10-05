import type { HostReport } from "@intentic/api-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { AdminDigestLine } from "./admin-digest.js";
import { DAY_MS } from "../durations.js";
import { hostReportsOf, reporterOf } from "../sandbox/host-report.js";

/* WHETHER A RELEASE BROUGHT OWNERS' MACHINES TO THE CURRENT SHAPE (2026-10-05). Each machine agent runs a standing
 * upkeep pass that clears what older releases left on its computer (retired installs, sync of deleted sandboxes, old
 * trash), and `ic sandbox fix` carries the last pass's counts on its host report (`upkeep`), with the agent's version.
 * This reads those reports across every sandbox, one per machine and environment, and sums them by agent version. A
 * machine on the newest agent that still holds leftovers its own pass could not clear is the one thing here a person
 * at intentic should look at: the release that was meant to clean it up did not. Older versions are only counted, since
 * their machines have not met the newest pass yet. */

// Reports older than this describe machines that may since have updated or gone; a report is posted every keeper pass.
const REPORT_WINDOW_MS = 7 * DAY_MS;

export interface ConvergenceRow {
    readonly version: string;
    readonly machines: number;
    // Machines whose last pass left something for a person (`skipped` above zero).
    readonly holding: number;
    readonly found: number;
    readonly fixed: number;
    readonly kinds: Readonly<Record<string, number>>;
}

// "1.330.0" > "1.329.2" > "unknown", by numeric parts. Pure.
const versionParts = (version: string): number[] => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);

export const newerVersion = (left: string, right: string): number => {
    const [a, b] = [versionParts(left), versionParts(right)];
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
};

/** One row per agent version, newest first, from reports that carry an upkeep summary; each reporter counted once, by
 * its newest report, however many sandboxes it reports for. Pure. */
export const upkeepConvergence = (reports: readonly HostReport[]): ConvergenceRow[] => {
    const newest = new Map<string, HostReport>();
    for (const report of reports) {
        if (report.upkeep === undefined) {
            continue;
        }
        const key = reporterOf(report);
        const held = newest.get(key);
        if (held === undefined || Date.parse(report.at) > Date.parse(held.at)) {
            newest.set(key, report);
        }
    }
    const rows = new Map<string, { machines: number; holding: number; found: number; fixed: number; kinds: Record<string, number> }>();
    for (const report of newest.values()) {
        const upkeep = report.upkeep;
        if (upkeep === undefined) {
            continue;
        }
        const version = upkeep.agentVersion ?? `unknown`;
        const row = rows.get(version) ?? { machines: 0, holding: 0, found: 0, fixed: 0, kinds: {} };
        row.machines += 1;
        row.holding += upkeep.skipped > 0 ? 1 : 0;
        row.found += upkeep.found;
        row.fixed += upkeep.fixed;
        for (const [kind, count] of Object.entries(upkeep.kinds ?? {})) {
            row.kinds[kind] = (row.kinds[kind] ?? 0) + count;
        }
        rows.set(version, row);
    }
    return [...rows.entries()].map(([version, row]) => ({ version, ...row })).toSorted((left, right) => newerVersion(right.version, left.version));
};

/** The digest's line, when machines on the newest agent still hold leftovers their own pass could not clear. Pure. */
export const convergenceDigestLines = (rows: readonly ConvergenceRow[]): AdminDigestLine[] => {
    const newest = rows.find((row) => row.version !== `unknown`);
    if (newest === undefined || newest.holding === 0) {
        return [];
    }
    const kinds = Object.entries(newest.kinds)
        .toSorted(([, left], [, right]) => right - left)
        .slice(0, 5)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(`, `);
    return [
        {
            severity: `warning`,
            title: `${newest.holding} of ${newest.machines} ${newest.machines === 1 ? `machine` : `machines`} on agent ${newest.version} still hold leftovers their upkeep could not clear`,
            ...(kinds === `` ? {} : { detail: `Found on them: ${kinds}. Their owners see each on This device; \`intentic-machine doctor\` there says why.` }),
        },
    ];
};

/** The host reports posted in the last week, across every sandbox row. */
export const recentHostReports = async (prisma: PrismaClient, now: () => Date = () => new Date()): Promise<HostReport[]> => {
    const since = new Date(now().getTime() - REPORT_WINDOW_MS);
    const rows = await prisma.sandbox.findMany({ where: { updatedAt: { gt: since }, hostReport: { not: Prisma.DbNull } }, select: { hostReport: true } });
    return rows.flatMap((row) => hostReportsOf(row.hostReport)).filter((report) => Date.parse(report.at) > since.getTime());
};
