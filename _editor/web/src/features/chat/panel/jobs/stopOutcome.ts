import type { StopOutcome } from "../../../../models/fleet/useAgents-actions";

// A person's Stop that stopped nothing (it had already ended, or its runner is out of reach) is said where they pressed,
// as a press that did not take, never passed off as a stop (2026-11-23). `said` words the reason.
export const stoppedOrSay = (outcome: StopOutcome, said: (reason: string) => string): void => {
    if (!outcome.stopped) {
        throw new Error(said(outcome.stopReason ?? ``));
    }
};
