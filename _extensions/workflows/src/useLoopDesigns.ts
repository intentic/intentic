import { type LoopDesign, LoopDesignsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The saved loops (.intentic/loop-designs.json), read and written through the daemon's /loops/designs routes.
 *
 * WHY THEY LIVE ON THIS PAGE. A loop and a workflow answer one question — what is the next message run
 * THROUGH — with two answers: a workflow spreads it across sessions that are not this one, a loop repeats it
 * in this one until a stated bar is cleared. Both are shapes you author once and point at a different job every
 * time, both are picked from the composer's badge row, and both leave the sentence to whatever you type. Two
 * things that are read, written and used the same way belong on one page; splitting them would have bought a
 * second entry in the rail and a second place to look.
 *
 * NOT POLLED, for the reason the designs beside them are not: the file is on the daemon's change push
 * (`loop-designs`, a CORE key — every composer lists these whether or not this extension is enabled), so an
 * edit here reaches a picker in another window without either side asking.
 */

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

/* A saved loop's id, minted from its name the way a manifest entry's always is here — lower-cased, punctuation
 * collapsed to dashes, bounded to what `entryId` accepts. A name that survives none of that (emoji, CJK) still
 * has to produce something, so it falls back to a stable-enough stamp rather than failing the save. */
export const loopIdFrom = (name: string, existing: readonly LoopDesign[]): string => {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, `-`)
        .replace(/^-+|-+$/gu, ``)
        .slice(0, 50);
    const stem = base === `` ? `loop` : base;
    // Suffixed until it is free, rather than refused: two loops called "until tests pass" is an ordinary thing
    // to want, and making the user rename one to save the second is the save refusing to do its job.
    if (!existing.some((design) => design.id === stem)) {
        return stem;
    }
    let n = 2;
    while (existing.some((design) => design.id === `${stem}-${n}`)) {
        n += 1;
    }
    return `${stem}-${n}`;
};
