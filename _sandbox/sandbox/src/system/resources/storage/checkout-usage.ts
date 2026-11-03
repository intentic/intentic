import type { CheckoutPressResult, CheckoutSize, CheckoutState, CheckoutUsage } from "@intentic/sandbox-contract/schemas/metrics";

// EVERY CHECKOUT, BY CONVERSATION (2026-11-03). On 11-03 one sandbox's 95 checkouts held 427 GB and the Storage card could
// say only "checkouts: 427 GB" and its eight biggest folders, with nothing to press: the owner could not tell which
// conversations were done, which held work nobody had landed, and which directories no conversation owned any more.
// The scan measures every conversation directory (storage-scan.ts checkoutSizes); this joins those sizes, as of the scan,
// with where each conversation stands now, and what may be done with it by the rules the daemon itself applies when
// asked (archive.ts, orphan-checkouts.ts).

// Where one conversation stands, read live; undefined for a directory gone since the scan.
export interface CheckoutFacts {
    readonly state: CheckoutState;
    readonly title?: string;
    readonly updatedAt?: number;
    // archive.ts buildOutputsReapable: nothing runs in it.
    readonly reapable: boolean;
    // archive.ts checkoutReleaseRefusal answered nothing.
    readonly releasable: boolean;
    // orphan-checkouts.ts leftoverRefusal answered nothing.
    readonly trashable: boolean;
}

export const checkoutUsageOf = async (
    sizes: readonly CheckoutSize[],
    factsOf: (id: string) => Promise<CheckoutFacts | undefined>,
): Promise<CheckoutUsage[]> => {
    const rows: CheckoutUsage[] = [];
    for (const size of sizes) {
        const facts = await factsOf(size.id);
        if (facts === undefined) {
            continue;
        }
        rows.push({
            ...size,
            state: facts.state,
            ...(facts.title === undefined ? {} : { title: facts.title }),
            ...(facts.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt }),
            can: {
                cleanBuildOutput: facts.reapable && size.buildOutputBytes > 0,
                release: facts.releasable && facts.state !== "leftover",
                trash: facts.trashable && facts.state === "leftover",
            },
        });
    }
    return rows;
};

// What the per-conversation presses run, handed in by the router from above the conversations subsystem.
export interface CheckoutActions {
    readonly factsOf: (id: string) => Promise<CheckoutFacts | undefined>;
    readonly clean: (id: string) => Promise<CheckoutPressResult>;
    readonly release: (id: string) => Promise<void>;
    readonly trash: (id: string) => Promise<void>;
}

// A press the conversation's state refuses, with the reason the route answers it with.
export class CheckoutActionRefused extends Error {}
