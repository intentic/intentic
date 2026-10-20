import { computed, type ComputedRef } from "vue";
import { t } from "@intentic/ui/i18n";
import { useBusySince, useProgress } from "../../../components/progress/useProgress";
import { type Progress, spanWords } from "../../../components/progress/progress";
import { useOperation, useOperationProgress } from "../../../workbench/operations/operations";
import { PROBE_TIMEOUT_MS } from "../setupAttach";

// THE TWO SETUP PRESSES THAT HOLD A SPINNER FOR A WHILE, timed for <ProgressMeter>: asking the platform for a machine
// (before its own steps and estimate take over the wait, hostedWait.ts) and probing an address on the attach lane.

export interface SetupWaits {
    readonly provisionWait: ComputedRef<Progress | undefined>;
    readonly attachWait: ComputedRef<Progress | undefined>;
    // What the attach press is doing: each probe gives up on its own after PROBE_TIMEOUT_MS, which it says.
    readonly attachNote: ComputedRef<string>;
}

export const useSetupWaits = (lanes: { readonly hostedBusy: ComputedRef<boolean>; readonly attaching: ComputedRef<boolean> }): SetupWaits => {
    // The attach press is the ledger's (useAttachLane.ts), so its clock is the run's own start, kept across a revisit.
    const attempt = useOperation(`setup/attach`);
    return {
        provisionWait: useProgress(useBusySince(lanes.hostedBusy)),
        attachWait: useOperationProgress(() => (lanes.attaching.value ? attempt.operation.value : undefined)),
        attachNote: computed(() => t(`setup.setup.attachingNote`, { limit: spanWords(PROBE_TIMEOUT_MS) })),
    };
};
