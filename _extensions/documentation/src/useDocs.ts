import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { type DocIndex, type RepoDoc, parseDocIndex, parseRepoDoc } from "./docModel.js";
import { host } from "./host.js";
import { holdsDraft, INDEX_TAIL, packagePageTail, publishedPath, REPO_DOC_TAIL, REPO_PROSE_TAIL, stagingDir, stagingPath } from "./paths.js";

// Reads a document set from either tree (published or staged); since they share tails, one reader serves both and the
// view just picks a source. No API, no server-side index: the files are the state.

export type DocSource = "published" | "staged";

const pathFor = (source: DocSource, repo: string, tail: string): string =>
    source === `staged` ? stagingPath(repo, tail) : publishedPath(repo, tail);

export interface DocSetState {
    readonly repoDoc: RepoDoc | undefined;
    readonly prose: string | undefined;
    readonly index: DocIndex | undefined;
}

export function useDocs(repo: Ref<string>, source: Ref<DocSource>) {
    const api = host();
    const queryClient = useQueryClient();

    // Matches the manifest's `contributes.files` key, so a config-docs write invalidates this with no poll.
    const key = computed(() => api.sandbox.key(`documentation`, source.value, repo.value));

    const json = async <T>(path: string): Promise<T | undefined> => {
        try {
            return (await api.sandbox.json(path)) as T;
        } catch {
            return undefined;
        }
    };

    // The set's three top-level files in one query; a missing one is the ordinary first state for an undocumented repo,
    // so reads answer undefined rather than throw.
    const setQuery = useQuery({
        queryKey: key,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<DocSetState> => {
            const [repoText, prose, indexText] = await Promise.all([
                api.workspace.file(pathFor(source.value, repo.value, REPO_DOC_TAIL)),
                api.workspace.file(pathFor(source.value, repo.value, REPO_PROSE_TAIL)),
                api.workspace.file(pathFor(source.value, repo.value, INDEX_TAIL)),
            ]);
            return {
                repoDoc: repoText === undefined ? undefined : parseRepoDoc(repoText),
                prose,
                index: indexText === undefined ? undefined : parseDocIndex(indexText),
            };
        },
    });

    // Fetched on open, not with the set, so a large monorepo doesn't cost a read per unclicked package. One read: the
    // page is the README, everything else about it already came in with the set's index.
    const usePackage = (dir: Ref<string | undefined>) =>
        useQuery({
            queryKey: computed(() => api.sandbox.key(`documentation`, `page`, source.value, repo.value, dir.value ?? ``)),
            enabled: computed(() => api.sandbox.reachable() && dir.value !== undefined),
            queryFn: async (): Promise<string | undefined> => {
                const at = dir.value;
                if (at === undefined) {
                    return undefined;
                }
                return await api.workspace.file(pathFor(source.value, repo.value, packagePageTail(at)));
            },
        });

    // Whether a repo has a staged set, from a directory listing (`holdsDraft`), since a half-written draft still
    // counts. Keyed `has-staged`: `staged` collides with `source`'s own value.
    const stagedQuery = useQuery({
        queryKey: computed(() => api.sandbox.key(`documentation`, `has-staged`, repo.value)),
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<boolean> => {
            const listing = await json<unknown>(`/workspace/children?path=${encodeURIComponent(stagingDir(repo.value))}`);
            return listing !== undefined && holdsDraft(WorkspaceChildrenSchema.parse(listing).entries.map((entry) => entry.name));
        },
    });

    const refresh = (): void => {
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation`) });
    };

    return {
        set: computed(() => setQuery.data.value),
        isLoading: setQuery.isLoading,
        hasStaged: computed(() => stagedQuery.data.value === true),
        usePackage,
        refresh,
    };
}
