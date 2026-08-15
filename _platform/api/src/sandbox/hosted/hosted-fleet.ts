import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../../config.js";
import { listAppNames } from "./fly.js";
import { hostedEnabled } from "./hosted.js";

/* WHAT IS ACTUALLY ON FLY, said in one screen — the operator's view the Fly console cannot give.
 *
 * The console lists apps by name, and a warm machine's name (`<prefix>-pool-<hex>`) is minted before anybody
 * has asked for it and can never change, so the moment a claim brands that app it is somebody's sandbox still
 * wearing a pool name. Reading the org's app list is therefore reading a story that stopped being true. The
 * platform's own rows never stop being true — HostedPoolMachine IS the standing stock, HostedMachine IS a
 * person's machine — so this joins Fly's list of what exists against them and names every app.
 *
 * Four things an app can be, and each is worth telling apart:
 *   warm     — built ahead of demand, nobody's, safe to destroy.
 *   claiming — a hand-off in flight (seconds) or a claim that crashed (the pool's reconcile collects it).
 *   taken    — a person's sandbox, with the owner and whether the hour meter is currently open.
 *   orphan   — on Fly with no row behind it: a failed build or a teardown that lost its race. The daily
 *              reaper destroys these; seeing them here is how an operator learns it has work to do.
 * A row whose app is gone from Fly is listed too (`missing`) — the mirror image, and the one case where the
 * platform believes in a machine that is not there. */

export type HostedFleetRole = `warm` | `claiming` | `taken` | `orphan`;

export interface HostedFleetEntry {
    readonly appName: string;
    readonly role: HostedFleetRole;
    readonly region: string;
    // Present for `taken` only — who the machine belongs to, and whether it is awake right now (an open
    // `wokeAt` is the hour meter's running stretch, which is the closest thing to "somebody is using it").
    readonly owner?: string;
    readonly sandboxId?: string;
    readonly awake?: boolean;
    // True when the platform holds a row for an app Fly no longer lists.
    readonly missing: boolean;
}

// The whole fleet, one entry per app the platform knows or Fly reports. Sorted so the two things an operator
// looks for — what is standing by, and what needs cleaning up — do not need hunting for.
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
            awake: row.wokeAt !== null,
            missing: !onFly.has(row.appName),
        })),
        ...pooled.map((row) => ({
            // `claimed` is the instant between a claim winning the row and the hand-off committing — never
            // stock, and never the platform's to destroy while it lasts.
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

// The same answer as text. `awake`/`asleep` is the hour meter's stretch, not a probe — the platform performs
// every wake but never witnesses the machine putting itself to sleep, so a machine that idled out reads
// `awake` until the usage sweep closes its stretch (hosted-usage.ts). Good enough for a glance, and the one
// number that is exact is the tally.
export const renderHostedFleet = (entries: HostedFleetEntry[]): string => {
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
    return [
        line([`ROLE`, `REGION`, `APP`, `OWNER`, `POWER`]),
        ...rows.map(line),
        ``,
        `${tally(`taken`)} taken · ${tally(`warm`)} warm · ${tally(`claiming`)} claiming · ${tally(`orphan`)} orphaned`,
    ].join(`\n`);
};

/* Run it: `pnpm --filter @intentic-app/api fleet`. A read-only script against the live platform's config and
 * database — it starts nothing, changes nothing, and is safe to point at production, which is the whole
 * reason it exists rather than a set of remembered curl commands. */
export const printHostedFleet = async (prisma: PrismaClient, config: Config): Promise<string> =>
    hostedEnabled(config) ? renderHostedFleet(await hostedFleet(prisma, config)) : `The hosted lane is off — no Fly credential configured.`;
