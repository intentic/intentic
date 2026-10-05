import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { destroyMachine, FLY_META_PLATFORM, listMachines, listVolumes } from "./fly/fly.js";
import { withHostedAppLock } from "./hosted-app-lock.js";
import { hostedEnabled, hostedInstanceId } from "./hosted.js";

/* EVERY PERSON'S APP HOLDS ITS ONE MACHINE AND ITS ONE DISK, checked daily (2026-10-05). `enforceAppShape`
 * (build/hosted-build.ts) holds an app to "its sandbox machine and this build's builder", but only while a build's
 * app-scoped token is alive. Outside a build nothing looked, so a machine that a failed move, a crashed adoption or a
 * leftover builder left in a sandbox's app ran, or sat stopped and billed, for good. This pass reads every app a
 * HostedMachine row names and holds it to the row:
 * - a machine other than the row's, stamped by this platform and past the grace window, is destroyed. A machine is
 *   cattle: the disk is the volume, which destroying a machine leaves where it is. A second machine of ours on one
 *   sandbox's token is a second copy of that sandbox, which is the very thing the announce's copy check looks for.
 * - a machine another deployment or nobody stamped is reported and never touched (the self-healing audit's rule 6: on
 *   doubt, skip and report). During a build it is destroyed, since only the build's own leaked token could have made
 *   it then; with no token alive that inference is not there to make.
 * - a volume other than the row's is reported and never touched. It is somebody's disk until proven otherwise: a
 *   move's source a failure kept, an older disk of the same sandbox.
 * An app mid-change (a build or a migration on its row, or its lock held) waits for the next pass, so a move's new
 * machine is never read as a stray, and an app whose row names a machine the listing lacks is only reported: the row
 * may be the stale half, and the health sweep's machine read settles that first (hosted-health.ts). At most
 * APP_SHAPE_DESTROYS_PER_PASS machines go per pass, and the rest wait for the next. */

// A machine this young may be one a provision or an adoption is making right now, under its own lock.
const SHAPE_GRACE_MS = 30 * 60 * 1000;
// The destruction cap: a verdict gone wrong costs one pass's worth of machines, never a fleet's.
export const APP_SHAPE_DESTROYS_PER_PASS = 10;

/* WHAT ONE PASS FOUND, for the retention sweep's log line and the admin digest. Entries name `<app>/<machine or volume
 * id>`. A type, not an interface, so it is the plain record a sweep step logs. */
export type HostedShapeReport = {
    readonly apps: number;
    readonly destroyed: readonly string[];
    readonly deferred: readonly string[];
    readonly foreignMachines: readonly string[];
    readonly strayVolumes: readonly string[];
    readonly rowMachineMissing: readonly string[];
    // Apps left for the next pass: mid-change, locked, or not answered.
    readonly waiting: number;
};

interface ShapeRow {
    readonly appName: string;
    readonly machineId: string;
    readonly volumeId: string;
    readonly migratingId: string | null;
    readonly buildingId: string | null;
}

interface ShapeTally {
    readonly destroyed: string[];
    readonly deferred: string[];
    readonly foreignMachines: string[];
    readonly strayVolumes: string[];
    readonly rowMachineMissing: string[];
}

// One app against its row, under the app's lock. Answers false when Fly would not list it.
const holdToShape = async (config: Config, logger: Logger, row: ShapeRow, tally: ShapeTally, now: number): Promise<boolean> => {
    const { flyApiToken } = config.hosted;
    const [machines, volumes] = await Promise.all([listMachines(flyApiToken, row.appName), listVolumes(flyApiToken, row.appName)]);
    const instance = hostedInstanceId(config);
    tally.strayVolumes.push(...volumes.filter((volume) => volume.id !== row.volumeId).map((volume) => `${row.appName}/${volume.id}`));
    const others = machines.filter((machine) => machine.id !== row.machineId);
    tally.foreignMachines.push(
        ...others.filter((machine) => machine.metadata[FLY_META_PLATFORM] !== instance).map((machine) => `${row.appName}/${machine.id}`),
    );
    if (!machines.some((machine) => machine.id === row.machineId)) {
        tally.rowMachineMissing.push(row.appName);
        return true;
    }
    const strays = others.filter(
        (machine) =>
            machine.metadata[FLY_META_PLATFORM] === instance &&
            machine.createdAt !== undefined &&
            now - machine.createdAt.getTime() >= SHAPE_GRACE_MS,
    );
    for (const stray of strays) {
        const name = `${row.appName}/${stray.id}`;
        if (tally.destroyed.length >= APP_SHAPE_DESTROYS_PER_PASS) {
            tally.deferred.push(name);
            continue;
        }
        logger.warn(
            { app: row.appName, machine: stray.id, state: stray.state },
            `hosted app shape: a machine of ours that its sandbox's row does not name; destroying it, its volume stays`,
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, and there is normally none
        await destroyMachine(flyApiToken, row.appName, stray.id, { force: true });
        tally.destroyed.push(name);
    }
    return true;
};

export const sweepHostedAppShapes = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: () => number = Date.now,
): Promise<HostedShapeReport> => {
    const tally: ShapeTally = { destroyed: [], deferred: [], foreignMachines: [], strayVolumes: [], rowMachineMissing: [] };
    if (!hostedEnabled(config)) {
        return { apps: 0, waiting: 0, ...tally };
    }
    const rows: ShapeRow[] = await prisma.hostedMachine.findMany({
        select: { appName: true, machineId: true, volumeId: true, migratingId: true, buildingId: true },
        orderBy: { appName: `asc` },
    });
    let waiting = 0;
    for (const row of rows) {
        if (row.migratingId !== null || row.buildingId !== null) {
            waiting += 1;
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one app at a time, gentle on the provider
        const held = await withHostedAppLock(config, row.appName, false, () => holdToShape(config, logger, row, tally, now())).catch(
            (error: unknown) => {
                logger.warn(
                    { err: error, app: row.appName },
                    `hosted app shape: this app could not be read or held to its shape; asked again tomorrow`,
                );
                return false;
            },
        );
        if (held !== true) {
            waiting += 1;
        }
    }
    if (tally.deferred.length > 0) {
        logger.warn(
            { cap: APP_SHAPE_DESTROYS_PER_PASS, deferred: tally.deferred },
            `hosted app shape: more stray machines than one pass destroys; the rest go tomorrow`,
        );
    }
    if (tally.foreignMachines.length > 0 || tally.strayVolumes.length > 0) {
        logger.warn(
            { foreignMachines: tally.foreignMachines, strayVolumes: tally.strayVolumes },
            `hosted app shape: machines this platform did not make, or volumes no row names, in sandboxes' apps; left for an operator`,
        );
    }
    return { apps: rows.length, waiting, ...tally };
};
