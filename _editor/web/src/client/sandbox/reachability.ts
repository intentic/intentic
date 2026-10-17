import type { SandboxSummary } from "@intentic/api-contract";
import { track } from "../../app/analytics";

// Reaching a sandbox other than the one in front: what a failed read reports, and what a deliberate retry does about it.

export const createReachabilityTelemetry = (capture: typeof track) => {
    // Every reader shares this session ledger: the switcher and changes list can fail on the same box together.
    const reported = new Set<string>();
    return (sandbox: SandboxSummary): void => {
        if (reported.has(sandbox.id)) {
            return;
        }
        reported.add(sandbox.id);
        // A machine that is booting is neither asleep nor broken, and counting it as down would inflate the outage rate.
        const state = sandbox.hosted?.state;
        capture(`sandbox_unreachable`, { cause: state === `asleep` || state === `starting` ? state : `down`, hosted: sandbox.hosted != null });
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
