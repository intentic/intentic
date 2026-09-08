import { WorkspaceChildrenSchema, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { BRIEF_OVERRIDE, STORIES_DIR, type Story, storiesOf, uniqueOf } from "./stories";

// All repos' stories, read straight off the workspace.
// - Every repo with `userStories` is walked in one pass; the repo becomes a field on each story.
// - Prefetched text is a display cache, not evidence; opening a story re-reads it.
// - The walk is bounded to `MAX_DEPTH`; a deep tree stops rather than crawls the repo.

const MAX_DEPTH = 3;
// Caps prefetch across the whole workspace; past this, titles fall back to filenames. Stated in the UI.
const MAX_PREFETCH = 200;

export interface StoriesState {
    readonly stories: readonly Story[];
    readonly contents: Readonly<Record<string, string>>;
    // Each repo's docs/user-stories/.acceptance.md, when it ships one.
    readonly notes: Readonly<Record<string, string>>;
    // Story files past the prefetch bound, left untitled.
    readonly unread: number;
}

export function useStories() {
    const api = host();
    const queryClient = useQueryClient();
    const key = computed(() => api.sandbox.key(`acceptance`, `stories`));

    // Repos that could hold stories: `userStories` ones, plus `hasPanel` ones so a first story has somewhere to go.
    const repos = computed<readonly string[]>(() =>
        api.workspace
            .repos()
            .filter((repo) => repo.userStories || repo.hasPanel)
            .map((repo) => repo.repo),
    );

    // Must stay above the query: an enabled query with nothing cached calls `queryFn` synchronously during setup, so
    // declaring these below typechecks but throws `Cannot access 'walk' before initialization` at runtime.

    const children = async (path: string): Promise<WorkspaceTreeEntry[]> =>
        WorkspaceChildrenSchema.parse(await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(path)}`)).entries;
    // Breadth-first to `MAX_DEPTH`. A missing or removed directory is an empty level, not an error.
    const walk = async (root: string): Promise<WorkspaceTreeEntry[]> => {
        const listed: WorkspaceTreeEntry[] = [];
        let frontier = [root];
        for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
            const levels = await Promise.all(frontier.map(async (path) => await children(path)));
            const entries = levels.flat();
            listed.push(...entries);
            frontier = entries.filter((entry) => entry.type === `dir` && !entry.name.startsWith(`.`)).map((entry) => entry.path);
        }
        return listed;
    };

    const query = useQuery({
        queryKey: computed(() => [...key.value, repos.value.join(`,`)]),
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<StoriesState> => {
            const perRepo = await Promise.all(repos.value.map(async (repo) => ({ repo, entries: await walk(`${repo}/${STORIES_DIR}`) })));
            const files = uniqueOf(perRepo.flatMap(({ repo, entries }) => storiesOf(repo, entries)));
            const read = files.slice(0, MAX_PREFETCH);
            const texts = await Promise.all(read.map(async (story) => [story.path, await api.workspace.file(story.path)] as const));
            const contents = Object.fromEntries(texts.flatMap(([path, body]) => (body === undefined ? [] : [[path, body] as const])));
            const overrides = await Promise.all(
                repos.value.map(async (repo) => [repo, await api.workspace.file(`${repo}/${BRIEF_OVERRIDE}`)] as const),
            );
            return {
                // Re-derived with fetched text so titles come from headings, not filenames; slugs stay the same either
                // way.
                stories: uniqueOf(perRepo.flatMap(({ repo, entries }) => storiesOf(repo, entries, contents))),
                contents,
                notes: Object.fromEntries(overrides.flatMap(([repo, body]) => (body === undefined ? [] : [[repo, body] as const]))),
                unread: files.length - read.length,
            };
        },
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: key.value });
    };

    // Writes one story at the caller's path; the path is never derived here, so a title edit doesn't move a file out
    // from under git.
    const save = async (input: { readonly path: string; readonly markdown: string }): Promise<void> => {
        await api.workspace.write(input.path, input.markdown);
        await invalidate();
    };

    const remove = async (path: string): Promise<void> => {
        await api.sandbox.json(`/workspace/entry`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path }),
        });
        await invalidate();
    };

    const stories = computed<readonly Story[]>(() => query.data.value?.stories ?? []);
    return {
        repos,
        stories,
        contents: computed<Readonly<Record<string, string>>>(() => query.data.value?.contents ?? {}),
        notes: computed<Readonly<Record<string, string>>>(() => query.data.value?.notes ?? {}),
        unread: computed<number>(() => query.data.value?.unread ?? 0),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        refresh: invalidate,
        save,
        remove,
    };
}
