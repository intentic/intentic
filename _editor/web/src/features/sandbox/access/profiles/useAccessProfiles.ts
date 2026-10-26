import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useRole } from "../../../../client/sandbox/useRole";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { apiClient } from "../../../../lib/useApi";
import { rpcKey, SANDBOX_MEMBERS } from "../../../../lib/queryKeys";

export function useAccessProfiles() {
    const cache = useQueryClient();
    const { canShip } = useRole();
    const { activeSandboxId } = useSandbox();
    const available = computed(() => canShip.value && supportsRoute(`accessProfiles.list`));
    const { query, loaded } = useSandboxQuery({ ...rpcQuery(`accessProfiles.list`), enabled: available });
    const invalidate = async (): Promise<void> => {
        await Promise.all([
            cache.invalidateQueries({ queryKey: rpcKey(`accessProfiles.list`) }),
            cache.invalidateQueries({ queryKey: SANDBOX_MEMBERS.of() }),
        ]);
    };
    const save = useMutation({
        mutationFn: async (profile: AccessProfile) => {
            if (!supportsRoute(`accessProfiles.save`)) {
                throw new Error(`accessProfiles.save`);
            }
            const sandboxId = activeSandboxId.value;
            if (sandboxId === undefined) {
                throw new Error(`sandboxId`);
            }
            // Read the platform before writing: the daemon rewrites the roster on save.
            const recorded = await apiClient.invite.list({ sandboxId });
            const answer = await sandboxRpc.accessProfiles.save(profile);
            try {
                const changes = answer.holders.filter(
                    (holder) => recorded.members.find((member) => member.email.toLowerCase() === holder.email.toLowerCase())?.role !== holder.role,
                );
                const results = await Promise.allSettled(
                    changes.map((holder) => apiClient.invite.setRole({ sandboxId, email: holder.email, role: holder.role })),
                );
                const failed = results.find((result) => result.status === `rejected`);
                if (failed?.status === `rejected`) {
                    throw failed.reason;
                }
            } finally {
                await invalidate();
            }
            return answer;
        },
    });
    const remove = useMutation({
        mutationFn: (id: string) => {
            if (!supportsRoute(`accessProfiles.remove`)) {
                throw new Error(`accessProfiles.remove`);
            }
            return sandboxRpc.accessProfiles.remove({ id });
        },
        onSuccess: invalidate,
    });
    return { available, loaded, query, profiles: computed(() => query.data.value?.profiles ?? []), save, remove };
}
