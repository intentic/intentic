import { WorkspaceChildrenSchema, WorkspaceFileSchema, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { BRIEF_OVERRIDE, criteriaOf, STORIES_DIR, type Story, storiesOf, uniqueOf } from "./stories";

/* EVERY repo's stories, read straight off the workspace. Three facts shape this:
 *
 *  • The area is workspace-wide, so the walk is too: every repo the daemon says carries `userStories` is listed
 *    in one pass, and the repo becomes a field on each story rather than the thing that addressed the view.
 *  • The story TEXT is fetched up front, not on demand, because everything this view does needs it — the title
 *    comes from the file's first heading, the criteria come from its checklist section, and starting a run
 *    inlines the whole file into the brief. Fetching it lazily would mean the list shows filenames until you commit.
 *  • Directories are walked to a bounded depth. A stories tree is written by hand; a deep one means someone
 *    pointed this at the wrong directory, and the walk should stop rather than crawl a repo.
 */

const MAX_DEPTH = 3;
// A prefetch bound across the WHOLE workspace, not a limit on what can be tested: past this the list falls back
// to filename titles rather than issuing hundreds of reads on first paint. Stated in the UI, never silent.
const MAX_PREFETCH = 200;

export interface StoriesState {
    readonly stories: readonly Story[];
    readonly contents: Readonly<Record<string, string>>;
    // Each repo's docs/user-stories/.acceptance.md, when it ships one.
    readonly notes: Readonly<Record<string, string>>;
    // How many story files went untitled because the prefetch bound was hit.
    readonly unread: number;
}

export function useStories() {
    const api = host();
    const queryClient = useQueryClient();
    const key = computed(() => api.sandbox.key(`acceptance`, `stories`));

    // Every repo that could hold stories. `userStories` is the daemon's own evidence; `hasPanel` repos are here
    // because they are where the FIRST story gets written, and a repo you cannot pick is a repo you cannot author in.
    const repos = computed<readonly string[]>(() =>
        api.workspace
            .repos()
            .filter((repo) => repo.userStories || repo.hasPanel)
            .map((repo) => repo.repo),
    );

    /* THE READERS ARE DECLARED BEFORE THE QUERY, and must stay that way. vue-query subscribes its observer
     * synchronously inside `useQuery`, so a query that is enabled and has nothing cached calls `queryFn` during
     * setup — before any `const` further down this function has been initialized. Declaring these below the
     * query typechecks fine and dies at runtime with `Cannot access 'walk' before initialization`, surfacing as
     * the view's error banner until a retry (by which time the closure is live) quietly succeeds. */

    const children = async (path: string): Promise<WorkspaceTreeEntry[]> => {
        try {
            return WorkspaceChildrenSchema.parse(await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(path)}`)).entries;
        } catch {
            return [];
        }
    };
    const text = async (path: string): Promise<string | undefined> => {
        try {
            return WorkspaceFileSchema.parse(await api.sandbox.json(`/workspace/file?path=${encodeURIComponent(path)}`)).content;
        } catch {
            return undefined;
        }
    };

    // Breadth-first to MAX_DEPTH. A directory that does not exist (or was removed under us) is an empty level,
    // not an error — the stories dir is a convention, and the daemon's facts may be a poll stale.
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
            const texts = await Promise.all(read.map(async (story) => [story.path, await text(story.path)] as const));
            const contents = Object.fromEntries(texts.flatMap(([path, body]) => (body === undefined ? [] : [[path, body] as const])));
            const overrides = await Promise.all(repos.value.map(async (repo) => [repo, await text(`${repo}/${BRIEF_OVERRIDE}`)] as const));
            return {
                // Re-derived with the fetched text so titles come from headings rather than filenames. The
                // cross-repo renumbering runs again on the same input, so slugs are identical either way.
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

    // Write one story. The PATH is the caller's, not derived here: the editor keeps an existing story's file
    // exactly where it is (a title edit must not move a file out from under git) and names only a new one after
    // its title, and that decision belongs where the user can see the filename it produces.
    const save = async (input: { readonly path: string; readonly markdown: string }): Promise<void> => {
        await api.sandbox.request(`/workspace/upload?path=${encodeURIComponent(input.path)}`, { method: `POST`, body: input.markdown });
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
        // The authored criteria per story path — the count each row shows, and what the brief is handed.
        criteria: computed<Readonly<Record<string, readonly string[]>>>(() =>
            Object.fromEntries(stories.value.map((story) => [story.path, criteriaOf(query.data.value?.contents[story.path])])),
        ),
        unread: computed<number>(() => query.data.value?.unread ?? 0),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        refresh: invalidate,
        save,
        remove,
    };
}
