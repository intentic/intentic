import type { DiskPressure } from "@intentic/sandbox-contract/schemas/metrics";

// How the attention list reads the daemon's disk-pressure watch (useDiskPressure.ts). Pure, so the row's wording is
// tested without a query.

// Whether a reading warrants telling the owner: under 10% free. Between 10% and 15% the daemon is already making room
// by itself, which is nothing to ask of anyone.
export const diskPressing = (pressure: DiskPressure | undefined): pressure is DiskPressure =>
    pressure !== undefined && (pressure.level === `low` || pressure.level === `critical`);

export const freePercent = (pressure: DiskPressure): number =>
    pressure.totalBytes <= 0 ? 0 : Math.floor((pressure.freeBytes / pressure.totalBytes) * 100);
