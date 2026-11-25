import type { ProcessRole } from "@intentic/sandbox-contract/schemas/metrics";
import { opt } from "../../opt.js";

// The minute's per-process summaries (resource-metrics.ts): the heaviest processes, and the memory each owner held.

// What a summary reads of one of the sampler's rows (resource-metrics.ts ProcessRow).
interface SummaryRow {
    readonly pid: number;
    readonly name: string;
    readonly program: string | undefined;
    readonly role: ProcessRole;
    readonly rssBytes: number;
    readonly swapBytes: number;
    readonly threads: number;
    readonly owner?: string | undefined;
    readonly jobId?: string | undefined;
}

// One row per heavy process, so a peak can be attributed after the fact; the roles above only say which bucket it was in,
// the owner and job whose work it was (2026-11-05: a 17.6 GB game client sat in this list as `other`, tied to nothing).
export interface TopProcess {
    readonly pid: number;
    readonly name: string;
    readonly program: string | undefined;
    readonly role: ProcessRole;
    readonly rssBytes: number;
    readonly swapBytes: number;
    readonly threads: number;
    readonly owner?: string;
    readonly jobId?: string;
}

const TOP_PROCESSES = 8;

// Heaviest first by resident plus swapped, since a paged-out process is still the one holding the memory.
export const topProcesses = (rows: readonly SummaryRow[], limit: number = TOP_PROCESSES): TopProcess[] =>
    rows
        .toSorted((left, right) => right.rssBytes + right.swapBytes - (left.rssBytes + left.swapBytes))
        .slice(0, limit)
        .map(({ pid, name, program, role, rssBytes, swapBytes, threads, owner, jobId }) => ({
            pid,
            name,
            program,
            role,
            rssBytes,
            swapBytes,
            threads,
            ...opt("owner", owner),
            ...opt("jobId", jobId),
        }));

// The key unstamped processes are summed under: no conversation id is one word, and neither reserved owner is this one.
const UNSTAMPED = "unstamped";

export interface OwnerSummary {
    readonly count: number;
    readonly rssBytes: number;
    readonly swapBytes: number;
}

/** Resident and swapped bytes by owner stamp, so a minute's line says whose work held the memory, not only what kind. */
export const ownerSums = (rows: readonly Pick<SummaryRow, "owner" | "rssBytes" | "swapBytes">[]): Record<string, OwnerSummary> => {
    const sums = new Map<string, OwnerSummary>();
    for (const { owner = UNSTAMPED, rssBytes, swapBytes } of rows) {
        const sum = sums.get(owner) ?? { count: 0, rssBytes: 0, swapBytes: 0 };
        sums.set(owner, { count: sum.count + 1, rssBytes: sum.rssBytes + rssBytes, swapBytes: sum.swapBytes + swapBytes });
    }
    return Object.fromEntries(sums);
};
