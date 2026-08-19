import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { type DocIndex, type RepoDoc, parseDocIndex, parseRepoDoc } from "./docModel.js";
import { host } from "./host.js";
import { holdsDraft, INDEX_TAIL, packagePageTail, publishedPath, REPO_DOC_TAIL, REPO_PROSE_TAIL, stagingDir, stagingPath } from "./paths.js";

/* Reading a document set. Both trees — published (in the repo) and staged (a draft awaiting the owner) — share
 * their tails, so ONE reader serves both and the view only chooses a source. That is the payoff of making
 * staging mirror the published layout instead of inventing a second shape for drafts.
 *
 * Everything here is a plain file read. There is no documentation API and no server-side index: the documents ARE
 * the state, which is what makes them reviewable in a diff, readable in the file tree, and correct for someone who
 * has only cloned the repo. */

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

    // `documentation` is the key the manifest's contributes.files declares, so a write under `.intentic/config/docs/`
    // invalidates exactly this — the staged tree appears as agents produce it, with no poll.
    const key = computed(() => api.sandbox.key(`documentation`, source.value, repo.value));

    const json = async <T>(path: string): Promise<T | undefined> => {
        try {
            return (await api.sandbox.json(path)) as T;
        } catch {
            return undefined;
        }
    };

    /* The set's three top-level files in one query. A missing set is the ordinary first state for every repo that
     * has never been documented, not an error — so each read answers undefined rather than throwing, and the view
     * renders its empty state from `repoDoc === undefined`. */
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

    /* One package's page, fetched when it is opened rather than with the set: a 50-package monorepo would
     * otherwise cost a read per package to render a list nobody has clicked yet.
     *
     * ONE read, not two. The page IS the README; everything the app needs about the package that is not prose —
     * its one-liner, its anchors, its measures, whether it is stale — is already in the index this composable
     * loaded with the set. That is what deleting the per-package sidecar bought, and it is why nothing here
     * parses. */
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

    /* Whether a repo has a STAGED set waiting. Read as a directory listing rather than by parsing the set,
     * because the question the banner asks is only "is there something to review", and a half-written draft (a
     * run still in flight) must answer yes. What a listing has to hold to count is `holdsDraft`'s business —
     * a derived index alone is not a draft, and believing it was is what emptied this whole area.
     *
     * `has-staged` rather than `staged` in the key, and that is not cosmetic: `staged` is a value `source` takes,
     * so this query and the SET query above collided on ["documentation", "staged", <repo>] for exactly the
     * repos that have a draft — the set's object landed under the boolean's key, `hasStaged` read it as false,
     * and the draft banner and the Published/Draft toggle vanished from the one case they exist for. */
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
