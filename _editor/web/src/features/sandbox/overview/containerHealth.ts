import type { SandboxSummary } from "@intentic/api-contract";

// Order is significant: drift outranks unreachable, which outranks refused.
export type ContainerFault = "drift" | "unreachable" | "refused";

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

export type ContainerEvidence = Pick<SandboxSummary, "bootReport" | "announceRefusal">;

/** Returns only the deepest fault found, never a shallower one it explains; empty means healthy. */
export const containerNotices = (sandbox: ContainerEvidence): readonly ContainerNotice[] => {
    const report = sandbox.bootReport;

    // Drift outranks the others: a recreate replays the same missing env, so restarting cannot clear it.
    const drift: ContainerNotice[] = (report?.drift ?? []).map((gap) => ({
        fault: "drift",
        title: `This sandbox was set up before it needed ${gap.enables}`,
        detail: gap.lost,
        repair: gap.repair,
        keys: gap.missing,
    }));
    if (drift.length > 0) {
        return drift;
    }

    // Only an explicit retrying === false is settled; absent means an older daemon, not a fault.
    if (report?.reach === `unreachable` && report.retrying === false) {
        return [
            {
                fault: "unreachable",
                title: `This sandbox does not answer at its public address`,
                detail: report.detail ?? `Its public address did not answer when the sandbox checked it from the inside.`,
            },
        ];
    }

    const refusal = sandbox.announceRefusal;
    if (refusal !== null && refusal !== undefined) {
        return [
            {
                fault: "refused",
                title: `This sandbox is checking in under an address the platform does not hold for it`,
                detail: `It announced ${refusal.announced}, while the platform has ${refusal.expected} on record. Until the two agree, anything sent to the recorded address misses it.`,
            },
        ];
    }

    return [];
};

export const hasContainerFault = (sandbox: ContainerEvidence): boolean => containerNotices(sandbox).length > 0;
