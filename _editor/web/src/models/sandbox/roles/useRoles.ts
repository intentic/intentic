import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { mapLoaded } from "@intentic/extension-api";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// Named roles (`.intentic/config/roles.json`) via the daemon's roles routes; saving or removing is a
// plain mutation plus refetch, no apply or stream. `connected` lists which named accounts this sandbox is actually
// signed into, separate from the roles.

export function useRoles() {
    const queryClient = useQueryClient();
    const { query, loaded } = useSandboxQuery(rpcQuery(`roles.list`));

    // Invalidates only this list; capabilities, environment and panels are unaffected.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`roles.list`) });

    // Upsert by id: saving an existing id edits that role.
    const save = useMutation({
        mutationFn: (role: Role) => sandboxRpc.roles.save(role),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxRpc.roles.remove({ id }),
        onSuccess: invalidate,
    });

    const roles = computed<Role[]>(() => query.data.value?.roles ?? []);
    const connected = computed<string[]>(() => query.data.value?.connected ?? []);
    return {
        roles,
        connected,
        // Checked per account id, not per role: a role naming three accounts needs only one connected.
        isConnected: (capabilityId: string): boolean => connected.value.includes(capabilityId),
        loaded: computed(() => mapLoaded(loaded.value, (answer) => answer.roles)),
        save,
        remove,
    };
}
