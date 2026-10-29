import type { GitBranches } from "@intentic/sandbox-contract/schemas/git/git";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, shallowRef, watch } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { UNPERSISTED } from "../../../lib/queryPersistence";
import { useChanges } from "../../../models/changes/useChanges";
import { useRepos } from "../../../models/workspace/tree/useRepos";
import { type BranchChoice, branchChoices } from "./scopeChoices";

// Every repository's branches for a list that is open: read when it opens, each repository on its own so one that cannot
// be read costs only its own rows, and held a little while so opening the list again draws at once.
const FRESH_MS = 30_000;

export const useBranchChoices = () => {
    const queryClient = useQueryClient();
    const { options: repos } = useRepos();
    // A repository something moved off its main line names it on its changes; that one is left out too.
    const { repos: changes } = useChanges();
    const listings = shallowRef<ReadonlyMap<string, GitBranches>>(new Map());
    const loading = ref(false);

    const read = (repo: string): Promise<readonly [string, GitBranches] | undefined> =>
        queryClient
            .fetchQuery({
                queryKey: rpcKey(`git.branches`, { repo }, UNPERSISTED),
                queryFn: () => sandboxRpc.git.branches({ repo }),
                staleTime: FRESH_MS,
            })
            .then((listing) => [repo, listing] as const)
            // allow(silent-catch): a repository whose branches cannot be read offers none; the rest still list theirs
            .catch(() => undefined);

    watch(
        () => repos.value.join(`\n`),
        async () => {
            loading.value = true;
            const answers = await Promise.all(repos.value.map(read));
            listings.value = new Map(answers.filter((entry) => entry !== undefined));
            loading.value = false;
        },
        { immediate: true },
    );

    const mains = computed(() => new Map(changes.value.flatMap((row) => (row.mainBranch === undefined ? [] : [[row.repo, row.mainBranch] as const]))));
    const choices = computed<readonly BranchChoice[]>(() =>
        repos.value.flatMap((repo) => {
            const listing = listings.value.get(repo);
            return listing === undefined ? [] : branchChoices(repo, listing, mains.value.get(repo));
        }),
    );
    return { choices, loading };
};
