import type { SandboxSummary } from "@intentic/api-contract";
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
            },
        ];
    }

    return [];
};

export const hasContainerFault = (sandbox: ContainerEvidence): boolean => containerNotices(sandbox).length > 0;
