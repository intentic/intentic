import { FREE_TIER, type HostedShape, type HostedTier, type HostedTierId, hostedTier } from "@intentic/constants";
import type { Config } from "../../config.js";
import type { FlyVolumeOptions } from "./fly/fly.js";

// Where a machine's shape comes from, and how two shapes are compared. Its own module rather than part of hosted.ts,
// because both the provisioner and the migration engine ask these questions and neither should have to import the
// other to do it.

/** The rung as this deployment runs it: the free rung's shape and hours are the operator's (`config.hosted`, 0 hours unmetered). */
export const hostedTierIn = (config: Config, id: string): HostedTier => {
    const rung = hostedTier(id);
    if (rung.id !== FREE_TIER.id) {
        return rung;
    }
    const { cpus, memoryMb, volumeGb, monthlyHours } = config.hosted;
    return { ...rung, cpus, memoryMb, volumeGb, monthlyHours };
};

export interface StoredShape {
    readonly cpuKind: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly volumeGb: number;
}

/** A row's own machine, the four shape fields and no more since a shape is spread into rows; any other CPU kind is corruption. */
export const shapeOfRow = ({ cpuKind, cpus, memoryMb, volumeGb }: StoredShape): HostedShape => {
    if (cpuKind !== `shared` && cpuKind !== `performance`) {
        throw new Error(`no cpu kind named ${cpuKind}; the provider has shared and performance`);
    }
    return { cpuKind, cpus, memoryMb, volumeGb };
};

/** The shape a machine on this rung gets. */
export const hostedShapeFor = (config: Config, tier: HostedTierId): HostedShape => shapeOfRow(hostedTierIn(config, tier));

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
