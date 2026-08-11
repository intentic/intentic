import { type DraftsList, type DraftSummary } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The sandbox's post-drafts queue (.intentic/drafts/, one file per draft), read/written via the daemon's
 * /drafts routes. The AGENT creates drafts with its file tools (taught by the daemon's drafts skill); this is
 * the OWNER's side — `save` upserts by id (approve/edit/retry are all a re-post with a field changed), `remove`
 * rejects. The publish automation's guard re-reads the files on its next fire, so there's nothing to provision.
 *
 * The manifest's `contributes.files` entry points `.intentic/drafts/` at this query key, so the agent dropping
 * a proposal in mid-conversation is on screen without a poll. */

export const draftsQuery = () => ({
    queryKey: host().sandbox.key(`drafts`),
    queryFn: (): Promise<DraftsList> => host().sandbox.rpc.drafts.list(),
});

// The split the badge and the mobile chip both need without mounting the view: what the queue OWES its owner.
// A proposal waiting for a yes, a post that failed, and a file the daemon could not read are the three states
// where nothing moves until the owner acts. Approved-and-scheduled goes out on its own and `posted` is history:
// counting either gives a badge that never returns to zero, which is how a badge stops being read. `broken` is
// the subset that is wrong rather than merely waiting — enough to pick a tone without re-deriving the split.
export const owedOf = (list: DraftsList | undefined): { owed: number; broken: number } => {
    const drafts = list?.drafts ?? [];
    const broken = drafts.filter((draft) => draft.status === `failed`).length + (list?.invalid.length ?? 0);
    return { owed: drafts.filter((draft) => draft.status === `proposed`).length + broken, broken };
};

export function useDrafts() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = draftsQuery();
    const { data, error, isLoading } = useQuery({
        ...spec,
        enabled: computed(() => api.sandbox.reachable()),
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: spec.queryKey });

    const save = useMutation({
        mutationFn: (draft: DraftSummary) => api.sandbox.rpc.drafts.upsert(draft),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.drafts.remove({ id }),
        onSuccess: invalidate,
    });

    const drafts = computed<DraftSummary[]>(() => data.value?.drafts ?? []);
    const invalid = computed<string[]>(() => data.value?.invalid ?? []);
    const broken = computed<number>(() => owedOf(data.value).broken);
    const owed = computed<number>(() => owedOf(data.value).owed);

    return {
        drafts,
        invalid,
        owed,
        broken,
        error: computed(() => error.value?.message),
        isLoading,
        save,
        remove,
    };
}
