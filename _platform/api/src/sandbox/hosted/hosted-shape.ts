import { FREE_TIER, type HostedShape, type HostedTierId, hostedTier, isHostedTierId } from "@intentic/constants";
import type { Config } from "../../config.js";
import type { FlyVolumeOptions } from "./fly/fly.js";

// Where a machine's shape comes from, and how two shapes are compared. Its own module rather than part of hosted.ts,
// because both the provisioner and the migration engine ask these questions and neither should have to import the
// other to do it.

/**
 * The shape a machine on this rung gets. The free rung's is the operator's to override (`config.hosted`), since a
 * self-hosted platform runs its own hardware; every paid rung's is the ladder's and not a deployment's to change.
 */
export const hostedShapeFor = (config: Config, tier: HostedTierId): HostedShape =>
    tier === FREE_TIER.id
        ? { cpuKind: FREE_TIER.cpuKind, cpus: config.hosted.cpus, memoryMb: config.hosted.memoryMb, volumeGb: config.hosted.volumeGb }
        : hostedTier(tier);

/**
 * The rung a stored name means. A row written before a rung was retired, or by a deployment on a different ladder,
 * reads as free rather than throwing: the machine is still somebody's, and refusing to describe it helps nobody.
 */
export const tierOfRow = (tier: string): HostedTierId => (isHostedTierId(tier) ? tier : FREE_TIER.id);

/** A shape as a row holds it: every column nullable, because a row may predate the columns or name no machine. */
export interface StoredShape {
    readonly cpuKind: string | null;
    readonly cpus: number | null;
    readonly memoryMb: number | null;
    readonly volumeGb: number | null;
}

/**
 * What a row says its machine is, falling back to its rung's shape column by column. The stored numbers win where
 * they exist, because they describe a guest and a volume that are actually out there; the rung is only the answer
 * for a row written before anything wrote them down.
 */
export const shapeOfRow = (config: Config, tier: HostedTierId, row: StoredShape): HostedShape => {
    const rung = hostedShapeFor(config, tier);
    return {
        cpuKind: row.cpuKind === `performance` || row.cpuKind === `shared` ? row.cpuKind : rung.cpuKind,
        cpus: row.cpus ?? rung.cpus,
        memoryMb: row.memoryMb ?? rung.memoryMb,
        volumeGb: row.volumeGb ?? rung.volumeGb,
    };
};

/**
 * How every hosted volume is created: on a host with room for the guest that will mount it, and with a snapshot
 * window this platform states rather than inherits. The placement hint is what keeps a later resize in place — a
 * volume placed with no hint can land on a host that cannot take the machine it is for, and then the only way up is
 * a move.
 */
export const volumeOptions = (config: Config, shape: HostedShape): FlyVolumeOptions => ({
    compute: { cpuKind: shape.cpuKind, cpus: shape.cpus, memoryMb: shape.memoryMb },
    ...(config.hosted.snapshotRetentionDays === 0 ? {} : { snapshotRetention: config.hosted.snapshotRetentionDays }),
});

/** Whether two shapes are the same machine, so an attempt to change to an identical one can answer "nothing to do". */
export const sameShape = (left: HostedShape, right: HostedShape): boolean =>
    left.cpuKind === right.cpuKind && left.cpus === right.cpus && left.memoryMb === right.memoryMb && left.volumeGb === right.volumeGb;
