import type { SandboxSummary } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";

// Order is significant: drift outranks duplicate, which outranks unreachable, which outranks refused.
export type ContainerFault = "drift" | "duplicate" | "unreachable" | "refused";

export interface ContainerNotice {
    readonly fault: ContainerFault;
    // Product-facing wording, not environment variable names.
    readonly title: string;
    // Rendered verbatim as received from the daemon; do not reword it here.
    readonly detail: string;
    readonly repair?: string;
    // Populated only for the drift fault: the environment keys this container is missing.
    readonly keys?: readonly string[];
}

export type ContainerEvidence = Pick<SandboxSummary, "bootReport" | "announceRefusal"> & Partial<Pick<SandboxSummary, "duplicateCopies">>;

/** Returns only the deepest fault found, never a shallower one it explains; empty means healthy. */
export const containerNotices = (sandbox: ContainerEvidence): readonly ContainerNotice[] => {
    const report = sandbox.bootReport;

    // Drift outranks the others: a recreate replays the same missing env, so restarting cannot clear it.
    const drift: ContainerNotice[] = (report?.drift ?? []).map((gap) => ({
        fault: "drift",
        title: t(`sandbox.containerHealth.sandboxSetUpBefore`, { enables: gap.enables }),
        detail: gap.lost,
        repair: gap.repair,
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
