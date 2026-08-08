import { type DraftsList, DraftsListSchema, type DraftSummary } from "@intentic-app/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The sandbox's post-drafts queue (.intentic/drafts/, one file per draft), read/written via the daemon's
 * /drafts routes. The AGENT creates drafts with its file tools; this is the OWNER's side — `save` upserts by id
 * (approve/edit/retry are all a re-post with a field changed), `remove` rejects. The publish automation's guard
 * re-reads the files on its next fire, so there's nothing to provision. */

const QUERY_KEY = sandboxKey(`drafts`);

// Named for the background loader, which warms this view's list from wherever the user is standing and must
// land in the same cache entry the view reads (composables/prefetch).
export const draftsKey = QUERY_KEY;
export const fetchDrafts = async (): Promise<DraftsList> => DraftsListSchema.parse(await sandboxJson(`/drafts`));

export function useDrafts() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchDrafts });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    const save = useMutation({
        mutationFn: (draft: DraftSummary) => sandboxJson(`/drafts`, jsonBody(`POST`, draft)),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxJson(`/drafts/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    const drafts = computed<DraftSummary[]>(() => query.data.value?.drafts ?? []);
    const invalid = computed<string[]>(() => query.data.value?.invalid ?? []);
    /* WHAT THE QUEUE OWES ITS OWNER, defined once because two surfaces badge it — the desktop rail's Drafts tile
     * and the phone's Review tab — and a count that meant one thing on a desk and another on a phone is the same
     * fact told two ways. A proposal waiting for a yes, a post that failed, and a file the daemon could not read
     * are the three states where nothing moves until the owner acts. Approved-and-scheduled is owed nothing (it
     * goes out on its own) and `posted` is history: counting either would give a badge that never returns to zero,
     * which is how a badge stops being read. `broken` is the subset that is wrong rather than merely waiting —
     * enough for a caller to pick its tone without re-deriving the split. */
    const broken = computed<number>(() => drafts.value.filter((draft) => draft.status === `failed`).length + invalid.value.length);
    const owed = computed<number>(() => drafts.value.filter((draft) => draft.status === `proposed`).length + broken.value);

    return {
        drafts,
        invalid,
        owed,
        broken,
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
