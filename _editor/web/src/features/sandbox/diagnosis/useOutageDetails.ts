import { useNow } from "@intentic/ui/async";
import { computed, type ComputedRef } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { outageDetails } from "./details";
import { diagnosisEvidence, useDiagnosis } from "./useDiagnosis";

// The raw facts behind the outage's sentence (details.ts), for whoever presses "Technical details": a few lines, rebuilt
// on the outage's own one-second clock while it lasts. `clock` is the visible outage (gates/useVisibleOutage.ts).
export const useOutageDetails = (clock: { readonly elapsed: ComputedRef<number> }): ComputedRef<string[]> => {
    const { active, connection, reachable } = useSandbox();
    const diagnosis = useDiagnosis(clock);
    const now = useNow(() => !reachable.value && connection.value.unavailableSince !== undefined);
    return computed(() =>
        outageDetails({
            connection: connection.value,
            evidence: diagnosisEvidence.value,
            report: active.value?.role === `owner` ? active.value.hostReport : undefined,
            diagnosis: diagnosis.value,
            now: now.value,
        }),
    );
};
