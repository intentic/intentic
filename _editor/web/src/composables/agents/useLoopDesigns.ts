import { type LoopDesign, LoopDesignSchema, LoopDesignsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { LOOP_DESIGNS } from "../queryKeys";
import { jsonBody } from "../sandbox/jsonBody";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* THE SAVED LOOPS — the manifest half of looping, read by the chat composer's loop picker and edited on the
 * page that owns them.
 *
 * IT LIVES IN CORE RATHER THAN IN THE WORKFLOWS EXTENSION, alongside `useWorkflowRuns` and for the same
 * reason: every composer in the app lists these, and a composer exists whether or not the extension that
 * edits them is switched on. Reading them through the extension would have made the picker go blank the day
 * an owner turned workflows off — a control that empties itself when an unrelated switch moves.
 *
 * NOT POLLED. A saved loop changes when a person edits one, and the daemon pushes that file change onto the
 * `loop-designs` key (core's WORKSPACE_STATE_FILES table), so the picker refreshes itself without asking. The
 * push matters more here than it does for most keys: the page that edits a loop and the composer that picks
 * one are routinely in DIFFERENT WINDOWS — a popped-out chat is its own — and nobody thinks to reopen a menu.
 */

// Shared, because vue-query caches by it and every composer in the app lands on one fetch between them. The
// daemon's file-change push invalidates by this exact name.
const designsKey = LOOP_DESIGNS.every;

export function useLoopDesigns() {
    const queryClient = useQueryClient();
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: designsKey });

    const { query, error } = useSandboxQuery<LoopDesign[]>({
        queryKey: designsKey,
        queryFn: async () => LoopDesignsListSchema.parse(await sandboxJson(`/loops/designs`)).designs,
    });

    // Create and update are one call with the intent spelled out, so a minted id that happens to collide is
    // refused rather than silently replacing somebody's loop.
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
