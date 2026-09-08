import { type LoopDesign, LoopDesignsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Saved loops (.intentic/config/loop-designs.json), via the daemon's /loops/designs routes. Live on the workflows page
// since both are designs authored once and pointed at a job later, picked the same way from the composer. Not polled:
// the file is on the daemon's change push (a core key), so an edit reaches other windows without polling.

export function useLoopDesigns() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`loop-designs`);
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<LoopDesign[]> => LoopDesignsListSchema.parse(await api.sandbox.json(`/loops/designs`)).designs,
        enabled: computed(() => api.sandbox.reachable()),
    });

    const save = useMutation({
        mutationFn: ({ design, create }: { design: LoopDesign; create: boolean }) =>
            api.sandbox.json(`/loops/designs`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ design, create }),
            }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/loops/designs/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    return { loops: computed<LoopDesign[]>(() => query.data.value ?? []), error: computed(() => query.error.value?.message), save, remove };
}

// Mints an id from the name: lower-cased, punctuation collapsed to dashes. A name with nothing left (emoji, CJK) falls
// back to a stable stamp rather than failing the save.
export const loopIdFrom = (name: string, existing: readonly LoopDesign[]): string => {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, `-`)
        .replace(/^-+|-+$/gu, ``)
        .slice(0, 50);
    const stem = base === `` ? `loop` : base;
    // Suffixed until free rather than refused; a duplicate name is ordinary, not an error.
    if (!existing.some((design) => design.id === stem)) {
        return stem;
    }
    let n = 2;
    while (existing.some((design) => design.id === `${stem}-${n}`)) {
        n += 1;
    }
    return `${stem}-${n}`;
};
