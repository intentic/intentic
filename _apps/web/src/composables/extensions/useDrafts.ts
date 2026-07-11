import { type DraftsList, DraftsListSchema, type DraftSummary } from "@intentic-app/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandboxClient";
import { sandboxKey, useSandbox } from "../useSandbox";

/* The sandbox's post-drafts queue (.intentic/drafts/, one file per draft), read/written via the daemon's
 * /drafts routes. The AGENT creates drafts with its file tools; this is the OWNER's side — `save` upserts by id
 * (approve/edit/retry are all a re-post with a field changed), `remove` rejects. The publish automation's guard
 * re-reads the files on its next fire, so there's nothing to provision. */

const QUERY_KEY = sandboxKey(`drafts`);

export function useDrafts() {
    const { reachable } = useSandbox();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<DraftsList> => DraftsListSchema.parse(await sandboxJson(`/drafts`)),
        enabled: reachable,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    const save = useMutation({
        mutationFn: (draft: DraftSummary) =>
            sandboxJson(`/drafts`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(draft),
            }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxJson(`/drafts/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    return {
        drafts: computed<DraftSummary[]>(() => query.data.value?.drafts ?? []),
        invalid: computed<string[]>(() => query.data.value?.invalid ?? []),
        error: computed(() => (query.error.value ? query.error.value.message : null)),
        isLoading: query.isLoading,
        save,
        remove,
    };
}
