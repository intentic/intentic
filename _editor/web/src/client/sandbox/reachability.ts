import type { SandboxSummary } from "@intentic/api-contract";
import { pageLeaving } from "@intentic/ui/reload-reason";
import { track } from "../../app/analytics";

// Reaching a sandbox other than the one in front: what a failed read reports, and what a deliberate retry does about it.

// How long a failure waits before it counts. A page on its way out cuts its own requests and stream, and each cut reads
// like the sandbox going away: in the week to 2026-10-27, 201 of 245 of these reports came from pages within 100 ms of
// leaving. A page that leaves runs no more timers, so a report that waits this long is never sent from one, however it
// left: a reload, a link, a closed tab.
const SETTLE_MS = 1_000;

export const createReachabilityTelemetry = (
    capture: typeof track,
    page: { readonly leaving: () => boolean; readonly later: (run: () => void, ms: number) => void } = {
        leaving: pageLeaving,
        later: (run, ms) => void setTimeout(run, ms),
    },
) => {
    // Every reader shares this session ledger: the switcher and changes list can fail on the same box together. A box is in
    // it from its first failure, so a second one while the first waits out SETTLE_MS is not a second report.
    const reported = new Set<string>();
    return (sandbox: SandboxSummary): void => {
        if (reported.has(sandbox.id) || page.leaving()) {
            return;
        }
        reported.add(sandbox.id);
        // A machine that is booting is neither asleep nor broken, and counting it as down would inflate the outage rate.
        const state = sandbox.hosted?.state;
        const properties = { cause: state === `asleep` || state === `starting` ? state : `down`, hosted: sandbox.hosted != null };
        page.later(() => {
            if (page.leaving()) {
                // Not an outage after all; if the page stays, the box's next failure is its own to report.
                reported.delete(sandbox.id);
                return;
            }
            capture(`sandbox_unreachable`, properties);
        }, SETTLE_MS);
    };
};
export const noteUnreachable = createReachabilityTelemetry(track);

// Only a deliberate press wakes a background sandbox. Polls remain reads, so browsing the fleet costs no boot.
export const retrySandboxRead = async (
    sandbox: SandboxSummary,
    wake: (sandboxId: string, source: `retry`) => Promise<void>,
    read: () => void | Promise<void>,
): Promise<void> => {
    if (sandbox.hosted !== null) {
        await wake(sandbox.id, `retry`);
    }
    await read();
};
