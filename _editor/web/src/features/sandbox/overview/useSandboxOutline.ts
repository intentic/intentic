import { computed, type Ref } from "vue";
import { activeSandboxId } from "./activeSandbox";
import { useLoadingReveal } from "@intentic/ui";

// Whether a sandbox view should show its outline, so no tab has to know the thresholds itself: useLoadingReveal
// scoped to the active sandbox, so switching starts a fresh wait instead of continuing the old one. The id comes
// from activeSandbox, not useSandbox, to avoid a heavier import chain.
export const useSandboxOutline = (loading: Ref<boolean>): Ref<boolean> =>
    useLoadingReveal(
        loading,
        computed(() => activeSandboxId.value ?? ``),
    );
