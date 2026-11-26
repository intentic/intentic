import type { OutwardAction } from "@intentic/sandbox-contract/schemas/data-protection";
import { computed, type ComputedRef } from "vue";
import { useSandboxScope } from "../../../client/sandbox/scope/useSandboxScope";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { legacyOutwardActions } from "./outwardActions";

/**
 * The outward actions Guardrails offers a rule for: what the sandbox's enabled extensions declare, as its daemon serves
 * them, or, from a daemon older than that route, the fixed list it gated, for the extensions switched on.
 */
export function useOutwardActions(): ComputedRef<readonly OutwardAction[]> {
    const scope = useSandboxScope();
    const served = computed(() => scope.supportsRoute(`settings.outwardActions`));
    const { query } = useSandboxQuery({ ...scope.query(`settings.outwardActions`), enabled: served }, scope.at);
    const { enabled } = useExtensions();
    return computed(() =>
        served.value ? (query.data.value?.actions ?? []) : legacyOutwardActions(new Set(enabled.value.map((extension) => extension.id))),
    );
}
