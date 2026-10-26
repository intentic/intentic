import type { Service } from "@intentic/sandbox-contract/schemas/services";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useRole } from "../../../../client/sandbox/useRole";
import { rpcKey } from "../../../../lib/queryKeys";

export function useServices() {
    const cache = useQueryClient();
    const { canShip } = useRole();
    const available = computed(() => canShip.value && supportsRoute(`services.list`));
    const { query, loaded } = useSandboxQuery({ ...rpcQuery(`services.list`), enabled: available });
    const invalidate = (): Promise<void> => cache.invalidateQueries({ queryKey: rpcKey(`services.list`) });
    const save = useMutation({
        mutationFn: (service: Service) => {
            if (!supportsRoute(`services.save`)) {
                throw new Error(`services.save`);
            }
            return sandboxRpc.services.save(service);
        },
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => {
            if (!supportsRoute(`services.remove`)) {
                throw new Error(`services.remove`);
            }
            return sandboxRpc.services.remove({ id });
        },
        onSuccess: invalidate,
    });
    const services = computed(() => query.data.value?.services ?? []);
    return {
        available,
        loaded,
        query,
        services,
        save,
        remove,
        labelOf: (id: string): string => services.value.find((service) => service.id === id)?.label ?? id,
    };
}
