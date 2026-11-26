import type { ModelRoleEntry } from "@intentic/sandbox-contract/models/model-roles";
import { computed, type ComputedRef } from "vue";
import { useSandboxScope } from "../../client/sandbox/scope/useSandboxScope";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { rolesBeforeContributions } from "./modelRoles";

export interface ModelRolesState {
    /** Every job, switched-off extensions' included, in the page's order; undefined until the list is read. */
    readonly roles: ComputedRef<readonly ModelRoleEntry[] | undefined>;
}

/**
 * The jobs a model setup can be chosen for: what the sandbox in scope serves (the active one outside any `<InSandbox>`,
 * so a run button resolving its job outside a page reads the same list), or, from a daemon older than that route, the
 * table it held (modelRoles.ts).
 */
export function useModelRoles(): ModelRolesState {
    const scope = useSandboxScope();
    const served = computed(() => scope.supportsRoute(`settings.modelRoles`));
    const { query } = useSandboxQuery({ ...scope.query(`settings.modelRoles`), enabled: served }, scope.at);
    return { roles: computed(() => (served.value ? query.data.value?.roles : rolesBeforeContributions())) };
}
