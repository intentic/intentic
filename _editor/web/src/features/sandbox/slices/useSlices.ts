import { type Slice, SlicesListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter } from "vue";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";
import { SLICES } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Named parts of the workspace (`.intentic/config/slices.json`) via the daemon's `/slices` routes. Readable by every
// member — a fenced person is shown the name of the fence they are behind, and a picker cannot offer what it cannot
// list — while the two writes are the sandbox owner's, refused in-route for anyone else.

const QUERY_KEY = SLICES.of();

const fetchSlices = async (): Promise<{ slices: Slice[] }> => SlicesListSchema.parse(await sandboxJson(`/slices`));

/**
 * `enabled` false holds the read, for the one tier the daemon refuses it: a desk reaches `/slices` only while it
 * actually holds one, so a desk with no fence would otherwise open the Access tab onto a 403 it can do nothing about.
 */
export function useSlices(enabled?: MaybeRefOrGetter<boolean>) {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchSlices, ...(enabled === undefined ? {} : { enabled }) });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    // Upsert by id: saving an existing id edits that slice, and everyone holding it moves with it.
    const save = useMutation({
        mutationFn: (slice: Slice) => sandboxJson(`/slices`, jsonBody(`POST`, slice)),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxJson(`/slices/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    const slices = computed<Slice[]>(() => query.data.value?.slices ?? []);
    return {
        slices,
        // A slice is named on screen the way it is named everywhere else; an id with no slice behind it reads as
        // itself rather than vanishing, since whoever holds it still holds it.
        labelOf: (id: string): string => slices.value.find((slice) => slice.id === id)?.label ?? id,
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
