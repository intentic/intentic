import type { LoopDesign } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { pushedKeys } from "../../../lib/queryKeys";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Saved loop designs, read by the composer's loop picker and edited on their own page. Lives in core rather than
// the workflows extension so composers still list them when workflows is off. Not polled: the daemon pushes
// changes onto the `loop-designs` key.

export function useLoopDesigns() {
    const queryClient = useQueryClient();
    // Everything the daemon's `loop-designs` push reaches, the workflows extension's own entries included, so a write
    // here refreshes that page too.
    const invalidate = async (): Promise<void> => {
        await Promise.all(pushedKeys([`loop-designs`]).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    };

    const { query, error } = useSandboxQuery(rpcQuery(`loops.designs`));

    // Create and update share this call; a colliding minted id is refused, not silently overwritten.
    const save = useMutation({
        mutationFn: (input: { design: LoopDesign; create: boolean }): Promise<LoopDesign> => sandboxRpc.loops.saveDesign(input),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxRpc.loops.removeDesign({ id }),
        onSuccess: invalidate,
    });

    return { designs: computed<LoopDesign[]>(() => query.data.value?.designs ?? []), error, save, remove };
}
