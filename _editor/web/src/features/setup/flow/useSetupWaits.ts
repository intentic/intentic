import { computed, type ComputedRef } from "vue";
import { t } from "@intentic/ui/i18n";
import { useBusySince, useWaitClock } from "../../../components/useWaitClock";
import type { WaitExpectation } from "../../../components/waitProgress";
import { spanWords } from "../../../components/waitProgress";
import { useOperation } from "../../../workbench/operations/operations";
import { PROBE_TIMEOUT_MS } from "../setupAttach";

// THE TWO SETUP PRESSES THAT HOLD A SPINNER FOR A WHILE, timed for <WaitProgress>: asking the platform for a machine
// (before its own steps and estimate take over the wait, hostedWait.ts) and probing an address on the attach lane.

export interface SetupWaits {
    readonly provisionWait: ComputedRef<WaitExpectation | undefined>;
    readonly attachWait: ComputedRef<WaitExpectation | undefined>;
    // What the attach press is doing: each probe gives up on its own after PROBE_TIMEOUT_MS, which it says.
    readonly attachNote: ComputedRef<string>;
}

export const useSetupWaits = (lanes: { readonly hostedBusy: ComputedRef<boolean>; readonly attaching: ComputedRef<boolean> }): SetupWaits => {
    // The attach press is the ledger's (useAttachLane.ts), so its clock is the run's own start, kept across a revisit.
    const attempt = useOperation(`setup/attach`);
    return {
        provisionWait: useWaitClock(useBusySince(lanes.hostedBusy)),
        attachWait: useWaitClock(() => (lanes.attaching.value ? attempt.operation.value?.startedAt : undefined)),
        attachNote: computed(() => t(`setup.setup.attachingNote`, { limit: spanWords(PROBE_TIMEOUT_MS) })),
    };
};
