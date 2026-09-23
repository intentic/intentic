import type { Area } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter } from "vue";
import { rpcQuery } from "../client/rpcQuery";
import { sandboxRpc } from "../client/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Named parts of the workspace (`.intentic/config/areas.json`) via the daemon's areas routes. Readable by every
// member — a fenced person is shown the name of the fence they are behind, and a picker cannot offer what it cannot
// list — while the two writes are the sandbox owner's, refused in-route for anyone else.

/**
 * `enabled` false holds the read, for the one tier the daemon refuses it: a guest reaches the list only while it
 * actually holds one, so a guest with no fence would otherwise open the Access tab onto a 403 it can do nothing about.
 */
export function useAreas(enabled?: MaybeRefOrGetter<boolean>) {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({ ...rpcQuery(`areas.list`), ...(enabled === undefined ? {} : { enabled }) });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`areas.list`) });

    // Upsert by id: saving an existing id edits that area, and everyone holding it moves with it.
    const save = useMutation({
        mutationFn: (area: Area) => sandboxRpc.areas.save(area),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxRpc.areas.remove({ id }),
        onSuccess: invalidate,
    });

    const areas = computed<Area[]>(() => query.data.value?.areas ?? []);
    return {
        areas,
        // An area is named on screen the way it is named everywhere else; an id with no area behind it reads as
        // itself rather than vanishing, since whoever holds it still holds it.
        labelOf: (id: string): string => areas.value.find((area) => area.id === id)?.label ?? id,
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
