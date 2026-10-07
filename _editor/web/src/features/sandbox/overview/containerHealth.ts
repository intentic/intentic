import type { SandboxSummary } from "@intentic/api-contract";
import { type Device, hostRunningSandbox } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// Order is significant: drift outranks duplicate, which outranks unreachable, which outranks refused.
export type ContainerFault = "drift" | "duplicate" | "unreachable" | "refused";

export interface ContainerNotice {
    readonly fault: ContainerFault;
    // Product-facing wording, not environment variable names.
    readonly title: string;
    // One sentence. The editor's own words where it knows the fault; a gap it has no words for shows the daemon's.
    readonly detail: string;
    // What to do by hand. Absent for drift: the card's own action row (reconnect, setup screen) is the repair.
    readonly repair?: string;
    // Populated only for the drift fault: the environment keys this container is missing.
    readonly keys?: readonly string[];
}

// Drift gaps the editor words itself, by the requirement's key: short, and translated, which the daemon's sentence is
// not. A key missing here (a newer daemon's requirement) falls back to the daemon's own `lost`.
const DRIFT_COPY: Readonly<Partial<Record<string, () => { readonly title: string; readonly detail: string }>>> = {
    reachability: () => ({
        title: t(`sandbox.containerHealth.unreachableElsewhere`),
        detail: t(`sandbox.containerHealth.setupPredatesPublicAddress`),
    }),
};

export type ContainerEvidence = Pick<SandboxSummary, "bootReport" | "announceRefusal"> & Partial<Pick<SandboxSummary, "duplicateCopies">>;

/** Returns only the deepest fault found, never a shallower one it explains; empty means healthy. */
export const containerNotices = (sandbox: ContainerEvidence): readonly ContainerNotice[] => {
    const report = sandbox.bootReport;

    // Drift outranks the others: a recreate replays the same missing env, so restarting cannot clear it.
    const drift: ContainerNotice[] = (report?.drift ?? []).map((gap) => ({
        fault: "drift",
        ...(DRIFT_COPY[gap.key]?.() ?? { title: t(`sandbox.containerHealth.setupOutOfDate`), detail: gap.lost }),
        keys: gap.missing,
    }));
    if (drift.length > 0) {
        return drift;
    }

    // Two containers holding this sandbox's one token, both checking in (the platform's `duplicateCopies`): they take
    // turns holding its address, so it drops about once a minute and every turn on it is cut. It outranks unreachable,
    // which it explains, and only a person can say which copy is the one to keep.
    const copies = sandbox.duplicateCopies;
    if (copies !== null && copies !== undefined && copies.hosts.length > 1) {
        return [
            {
                fault: "duplicate",
                title: t(`sandbox.containerHealth.twoCopiesRunning`),
                detail: t(`sandbox.containerHealth.copiesTakeTurns`, { hosts: copies.hosts.join(`, `) }),
                repair: t(`sandbox.containerHealth.removeTheOtherCopy`),
            },
        ];
    }

    // Only an explicit retrying === false is settled; absent means an older daemon, not a fault.
    if (report?.reach === `unreachable` && report.retrying === false) {
        return [
            {
                fault: "unreachable",
                title: t(`sandbox.containerHealth.sandboxDoesNotAnswer`),
                detail: report.detail ?? t(`sandbox.containerHealth.publicAddressDidNotAnswer`),
                repair: t(`sandbox.containerHealth.runFixOnItsComputer`),
            },
        ];
    }

    const refusal = sandbox.announceRefusal;
    if (refusal !== null && refusal !== undefined) {
        return [
            {
                fault: "refused",
                title: t(`sandbox.containerHealth.sandboxCheckingInUnder`),
                detail: t(`sandbox.containerHealth.announcedWhilePlatformOn`, { announced: refusal.announced, expected: refusal.expected }),
                repair: t(`sandbox.containerHealth.runFixOnItsComputer`),
            },
        ];
    }

    return [];
};

export const hasContainerFault = (sandbox: ContainerEvidence): boolean => containerNotices(sandbox).length > 0;

// Reconnecting reinstalls the container from a fresh setup code: the repair for a setup that is out of date, and for
// nothing else. A sandbox that stops answering, or checks in under the wrong address, is a fault of the box as it
// stands, which a reinstall only hides; each of those says what to run instead (`repair`). (2026-10-07)
export const offersReconnect = (notice: ContainerNotice): boolean => notice.fault === `drift`;

// The door a reconnect runs through. Windows and the WSL distros on it share one Docker engine, so every side lists the
// sandbox, and a reconnect run from a side other than the one that made it used to set the sandbox up again as that
// side's (2026-10-07). Each side's listing names the OTHER side when that one keeps it (`keptElsewhere`), so the door
// whose listing names no other side is the one that made it; a side that only adopted it while its keeper was silent
// comes after one that made it. With no side named anywhere (one door, an older ic), the shared rule's first door.
export const reconnectDoor = (devices: readonly Device[], slug: string | undefined): string | undefined => {
    const listing = (device: Device) => (device.sandboxes ?? []).find((box) => box.slug === slug);
    const doors = devices.filter((device) => device.hostId !== undefined && device.online === true && listing(device) !== undefined);
    if (!doors.some((door) => listing(door)?.keptElsewhere !== undefined)) {
        return hostRunningSandbox(devices, slug);
    }
    const own = doors.filter((door) => listing(door)?.keptElsewhere === undefined);
    const maker = own.find((door) => listing(door)?.adoptedFrom === undefined) ?? own[0];
    return maker?.hostId ?? hostRunningSandbox(devices, slug);
};
