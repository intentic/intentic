import type { RoleKit } from "@intentic/sandbox-contract/schemas/roles";
import type { SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { useMutation } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// A role's kit: prompt and skills at `.intentic/config/roles/<id>/`, fetched only for the open role (unlike
// useRoles, which lists roles). The daemon's `roles` push refreshes every kit along with the list; the id is
// reactive (accordion) and never absent (missing roles 404).

export function useRoleKit(roleId: MaybeRefOrGetter<string>) {
    const id = computed(() => toValue(roleId));

    const { query, error } = useSandboxQuery(rpcQuery(`roles.kit`, () => ({ id: id.value })));

    // Invalidates only this role's kit; nothing else changes.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`roles.kit`, { id: id.value }) });

    // Passed explicitly so `useMutation` doesn't need Vue's injection context to find the client.
    const savePrompt = useMutation(
        { mutationFn: (prompt: string) => sandboxRpc.roles.savePrompt({ id: id.value, prompt }), onSuccess: invalidate },
        queryClient,
    );
    const saveSkill = useMutation(
        { mutationFn: (skill: SkillDraft) => sandboxRpc.roles.saveSkill({ id: id.value, ...skill }), onSuccess: invalidate },
        queryClient,
    );
    const removeSkill = useMutation(
        { mutationFn: (name: string) => sandboxRpc.roles.removeSkill({ id: id.value, name }), onSuccess: invalidate },
        queryClient,
    );

    return {
        kit: computed<RoleKit>(() => query.data.value ?? { prompt: ``, skills: [] }),
        // Fetches one skill's body on demand; the list view must not pay for every skill's content up front.
        readSkill: (name: string) => sandboxRpc.roles.readSkill({ id: id.value, name }),
        error,
        isLoading: query.isLoading,
        savePrompt,
        saveSkill,
        removeSkill,
    };
}
