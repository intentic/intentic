import { type RepoChecksList, RepoChecksListSchema, type RepoChecksSummary } from "@intentic/sandbox-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { queryClient } from "../../../lib/queryPersistence";
import { REPO_CHECKS, SANDBOX_SETTINGS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// What each repository asks to have run on its own code, and whether the owner has said yes. Read separately from the
// settings, because the declaration is a tracked file inside the repository: it changes with a commit or a pull, while
// the settings only change when somebody edits them here.

const QUERY_KEY = REPO_CHECKS.of();

export function useRepoChecks() {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<RepoChecksList> => RepoChecksListSchema.parse(await sandboxJson(`/settings/repo-checks`)),
    });

    const adopt = useMutation(
        {
            mutationFn: ({ repo, on }: { repo: string; on: boolean }) => sandboxJson(`/settings/repo-checks/adopt`, jsonBody(`POST`, { repo, on })),
            // Both, and only after the write: adoption is recorded in the settings, so a screen still holding the old
            // settings would disagree with the row that just changed.
            onSettled: async () => {
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
                    queryClient.invalidateQueries({ queryKey: SANDBOX_SETTINGS.of() }),
                ]);
            },
        },
        queryClient,
    );

    // Undefined while unread, so a row can tell "no repository declares anything" from "not read yet" — the difference
    // between an empty state and a lie.
    const repos = computed<readonly RepoChecksSummary[] | undefined>(() => query.data.value?.repos);

    return {
        repos,
        error,
        isLoading: query.isLoading,
        busy: computed(() => adopt.isPending.value),
        // The repository whose adoption is in flight, so only that row's control goes quiet.
        pending: computed<string | undefined>(() => (adopt.isPending.value ? adopt.variables.value?.repo : undefined)),
        adopt: (repo: string, on: boolean): void => adopt.mutate({ repo, on }),
    };
}
