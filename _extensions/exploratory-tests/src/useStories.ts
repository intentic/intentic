import { WorkspaceChildrenSchema, WorkspaceFileSchema, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";
import { BRIEF_OVERRIDE, STORIES_DIR, type Story, storiesOf } from "./stories";

/* One repo's stories, read straight off the workspace. Two facts shape this:
 *
 *  • The story TEXT is fetched up front, not on demand, because both things this view does need it — the title
 *    comes from the file's first heading, and starting a run inlines the whole file into the brief. Fetching it
 *    twice (once to label a checkbox, once to run) would double the requests for no gain, and fetching it only
 *    at run time would mean the list shows filenames until you commit.
 *  • Directories are walked to a bounded depth. A stories tree is written by hand; a deep one means someone
 *    pointed this at the wrong directory, and the walk should stop rather than crawl a repo.
 */

const MAX_DEPTH = 3;
// A prefetch bound, not a limit on what can be tested: past this the list falls back to filename titles rather
// than issuing hundreds of reads on first paint. Stated in the UI, never silent.
const MAX_PREFETCH = 200;

export interface StoriesState {
    readonly stories: readonly Story[];
    readonly contents: Readonly<Record<string, string>>;
    // docs/user-stories/.exploratory.md, when the repo ships one.
    readonly projectNotes?: string;
    // How many story files went untitled because the prefetch bound was hit.
    readonly unread: number;
}

export function useStories(repo: Ref<string>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`exploratory`, `stories`, repo.value)),
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<StoriesState> => {
            const root = `${repo.value}/${STORIES_DIR}`;
            const listed: WorkspaceTreeEntry[] = [];
            let frontier = [root];
            for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
                const levels = await Promise.all(frontier.map(async (path) => await children(path)));
                const entries = levels.flat();
                listed.push(...entries);
                frontier = entries.filter((entry) => entry.type === `dir` && !entry.name.startsWith(`.`)).map((entry) => entry.path);
            }
            const files = storiesOf(repo.value, listed);
            const read = files.slice(0, MAX_PREFETCH);
            const texts = await Promise.all(read.map(async (story) => [story.path, await text(story.path)] as const));
            const contents = Object.fromEntries(texts.flatMap(([path, body]) => (body === undefined ? [] : [[path, body] as const])));
            const notes = await text(`${repo.value}/${BRIEF_OVERRIDE}`);
            return {
                // Re-derived with the fetched text so titles come from headings rather than filenames.
                stories: storiesOf(repo.value, listed, contents),
                contents,
                ...(notes === undefined ? {} : { projectNotes: notes }),
                unread: files.length - read.length,
            };
        },
    });

    // A directory that does not exist (or was removed under us) is an empty level, not an error — the stories
    // dir is a convention, and `userStories` was computed by the daemon on a poll that may be a second stale.
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

    return {
        stories: computed<readonly Story[]>(() => query.data.value?.stories ?? []),
        contents: computed<Readonly<Record<string, string>>>(() => query.data.value?.contents ?? {}),
        projectNotes: computed<string | undefined>(() => query.data.value?.projectNotes),
        unread: computed<number>(() => query.data.value?.unread ?? 0),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        refresh: query.refetch,
    };
}
