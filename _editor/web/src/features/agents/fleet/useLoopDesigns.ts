import { type LoopDesign, LoopDesignSchema, LoopDesignsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { LOOP_DESIGNS } from "../../../lib/queryKeys";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Saved loop designs, read by the composer's loop picker and edited on their own page. Lives in core rather than
// the workflows extension so composers still list them when workflows is off. Not polled: the daemon pushes
// changes onto the `loop-designs` key.

// Shared across composers so they land on one cached fetch; the daemon's push invalidates by this exact key.
const designsKey = LOOP_DESIGNS.every;

export function useLoopDesigns() {
    const queryClient = useQueryClient();
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: designsKey });

    const { query, error } = useSandboxQuery<LoopDesign[]>({
        queryKey: designsKey,
        queryFn: async () => LoopDesignsListSchema.parse(await sandboxJson(`/loops/designs`)).designs,
    });

    // Create and update share this call; a colliding minted id is refused, not silently overwritten.
    const save = useMutation({
        mutationFn: async ({ design, create }: { design: LoopDesign; create: boolean }): Promise<LoopDesign> =>
            LoopDesignSchema.parse(await sandboxJson(`/loops/designs`, jsonBody(`POST`, { design, create }))),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxJson(`/loops/designs/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    return { designs: computed<LoopDesign[]>(() => query.data.value ?? []), error, save, remove };
}
