import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { FLY_META_OWNER, listAppNames, setMachineMetadata } from "./fly/fly.js";
import { hostedCapacity } from "./hosted-capacity.js";
import { hostedEnabled } from "./hosted.js";

// What is actually on Fly, in one screen: joins Fly's app list against the platform's own rows (HostedPoolMachine is
// stock, HostedMachine is a person's machine) to name every app. Four roles:
// - warm: built ahead of demand, nobody's, safe to destroy
// - claiming: a hand-off in flight, or a crashed claim the pool's reconcile collects
// - taken: a person's sandbox
// - orphan: on Fly with no row behind it; the daily reaper destroys these
// A row whose app is gone from Fly is `missing`, the mirror case.

export type HostedFleetRole = `warm` | `claiming` | `taken` | `orphan`;

export interface HostedFleetEntry {
    readonly appName: string;
    readonly role: HostedFleetRole;
    readonly region: string;
    // Present for `taken` only: owner, and whether awake (an open `wokeAt` is the meter's running stretch).
    readonly owner?: string;
    readonly sandboxId?: string;
    // `taken` only, and only so the owner stamp below can be written without a config replacement.
    readonly machineId?: string;
    readonly awake?: boolean;
    // True when the platform holds a row for an app Fly no longer lists.
    readonly missing: boolean;
}

// Sort order: taken and claiming first, then warm stock, then orphans.
const ORDER: Record<HostedFleetRole, number> = { taken: 0, claiming: 1, warm: 2, orphan: 3 };

export const hostedFleet = async (prisma: PrismaClient, config: Config): Promise<HostedFleetEntry[]> => {
    const prefix = `${config.hosted.appPrefix}-`;
    const [apps, machines, pooled] = await Promise.all([
        listAppNames(config.hosted.flyApiToken, config.hosted.flyOrg),
        prisma.hostedMachine.findMany({ include: { sandbox: { include: { owner: { select: { email: true } } } } } }),
        prisma.hostedPoolMachine.findMany(),
    ]);
    const onFly = new Set(apps.filter((name) => name.startsWith(prefix)));
    const entries: HostedFleetEntry[] = [
        ...machines.map((row) => ({
            appName: row.appName,
            role: `taken` as const,
            region: row.region,
            owner: row.sandbox.owner.email,
            sandboxId: row.sandboxId,
            machineId: row.machineId,
            awake: row.wokeAt !== null,
            missing: !onFly.has(row.appName),
        })),
        ...pooled.map((row) => ({
            // The instant between winning the row and the hand-off committing; never stock, never ours to destroy
            // meanwhile.
            appName: row.appName,
            role: (row.state === `claimed` ? `claiming` : `warm`) as HostedFleetRole,
            region: row.region,
            missing: !onFly.has(row.appName),
        })),
    ];
    const known = new Set(entries.map((entry) => entry.appName));
    for (const appName of [...onFly].filter((name) => !known.has(name))) {
        entries.push({ appName, role: `orphan`, region: `?`, missing: false });
    }
    return entries.toSorted((left, right) => ORDER[left.role] - ORDER[right.role] || left.appName.localeCompare(right.appName));
};

/* BACKFILLS THE OWNER STAMP onto machines that were created before the platform wrote one (fly.ts
 * FLY_META_OWNER). New and re-configured machines carry it already; a stopped machine nobody has claimed or
 * rebuilt since would otherwise never get one, which is precisely the fleet somebody is squinting at in the Fly
 * console asking whose each machine is.
 *
 * Writes one metadata key per machine, never a config: nothing restarts, nothing wakes, and a machine that is
 * already stamped is skipped so re-running this costs almost nothing. Best effort per machine — a Fly refusal on
 * one is reported and the rest still get stamped. */
export const stampHostedOwners = async (
    prisma: PrismaClient,
    config: Config,
    report: (line: string) => void = () => undefined,
): Promise<{ stamped: number; failed: number }> => {
    const entries = (await hostedFleet(prisma, config)).filter(
        (entry) => entry.role === `taken` && !entry.missing && entry.machineId !== undefined && entry.owner !== undefined,
    );
    let stamped = 0;
    let failed = 0;
    for (const entry of entries) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one small write per machine, gentle on a rate-limited API
            await setMachineMetadata(config.hosted.flyApiToken, entry.appName, entry.machineId ?? ``, FLY_META_OWNER, entry.owner ?? ``);
            stamped += 1;
            report(`stamped ${entry.appName} -> ${entry.owner ?? ``}`);
        } catch (error) {
            failed += 1;
            report(`FAILED ${entry.appName}: ${error instanceof Error ? error.message : `unknown`}`);
        }
    }
    return { stamped, failed };
};

// awake/asleep reflects the hour meter's stretch, not a live probe: an idled-out machine still reads `awake` until the
// usage sweep closes it. `capacity` adds headroom against the ceiling, omitted when none is configured.
export const renderHostedFleet = (entries: HostedFleetEntry[], capacity?: { used: number | undefined; cap: number; full: boolean }): string => {
    const rows = entries.map((entry) => [
        entry.role.toUpperCase(),
        entry.region,
        entry.appName,
        entry.missing ? `GONE FROM FLY` : (entry.owner ?? ``),
        entry.role === `taken` ? (entry.awake === true ? `awake` : `asleep`) : ``,
    ]);
    const widths = [`ROLE`, `REGION`, `APP`, `OWNER`, `POWER`].map((head, column) =>
        Math.max(head.length, ...rows.map((row) => (row[column] ?? ``).length)),
    );
    const line = (cells: string[]) =>
        cells
            .map((cell, column) => cell.padEnd(widths[column] ?? 0))
            .join(`  `)
            .trimEnd();
    const tally = (role: HostedFleetRole) => entries.filter((entry) => entry.role === role).length;
    // Shown only when there's a ceiling to measure against: `used` only means something there.
    const room =
        capacity === undefined || capacity.cap === 0 || capacity.used === undefined
            ? ``
            : ` · ${capacity.used} of ${capacity.cap} machines${capacity.full ? ` — FULL, nobody can be given a new one` : ``}`;
    return [
        line([`ROLE`, `REGION`, `APP`, `OWNER`, `POWER`]),
        ...rows.map(line),
        ``,
        `${tally(`taken`)} taken · ${tally(`warm`)} warm · ${tally(`claiming`)} claiming · ${tally(`orphan`)} orphaned${room}`,
    ].join(`\n`);
};

// Run via `pnpm --filter @intentic/api fleet`: read-only against the live config and database, safe to point at
// production.
export const printHostedFleet = async (prisma: PrismaClient, config: Config): Promise<string> => {
    if (!hostedEnabled(config)) {
        return `The hosted lane is off, no Fly credential configured.`;
    }
    const [entries, capacity] = await Promise.all([hostedFleet(prisma, config), hostedCapacity(prisma, config)]);
    return renderHostedFleet(entries, capacity);
};
