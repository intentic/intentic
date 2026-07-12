import { WorkspaceTreeSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

// The tree's recursive shape. WorkspaceTreeSchema validates it, but zod's getter-form recursion infers
// `children` too loosely to walk, so the walk is typed against this explicit interface (the parsed data is
// cast to it — the schema already guaranteed the shape).
export interface TreeEntry {
    readonly name: string;
    readonly path: string;
    readonly type: "file" | "dir";
    readonly children?: readonly TreeEntry[];
}

/* One repo's vitest projects, derived from the shared /workspace/tree cache (view-level — detect() stays on
 * daemon facts). A project is the nearest package.json dir owning vitest evidence: a vitest.config.* file OR a
 * *.test.* file — the config-less case is real (bare `vitest run` needs no config). The tree query uses the
 * same cache key the editor's file tree does (api.sandbox.key), so on the shared QueryClient the two dedupe to
 * one fetch. */

const isEvidence = (name: string): boolean => name.startsWith(`vitest.config.`) || name.includes(`.test.`);

// Root-relative project dirs (e.g. "repositories/intentic/_libs/engine"), sorted; the repo root itself when
// evidence sits above any nested package.json.
export const vitestProjects = (tree: readonly TreeEntry[], repo: string): string[] => {
    const repoDir = tree.find((entry) => entry.name === `repositories`)?.children?.find((entry) => entry.name === repo);
    if (repoDir?.children === undefined) {
        return [];
    }
    const projects = new Set<string>();
    const walk = (dir: TreeEntry, pkg: string): void => {
        const children = dir.children ?? [];
        const here = children.some((child) => child.type === `file` && child.name === `package.json`) ? dir.path : pkg;
        for (const child of children) {
            if (child.type === `file` && isEvidence(child.name)) {
                projects.add(here);
            } else if (child.type === `dir`) {
                walk(child, here);
            }
        }
    };
    walk(repoDir, repoDir.path);
    return [...projects].toSorted();
};

export function useVitest(repo: Ref<string>) {
    const api = host();
    const treeQuery = useQuery({
        queryKey: api.sandbox.key(`workspace`, `tree`),
        queryFn: async () => WorkspaceTreeSchema.parse(await api.sandbox.json(`/workspace/tree`)),
        enabled: computed(() => api.sandbox.reachable()),
    });
    const projects = computed(() => vitestProjects((treeQuery.data.value?.tree ?? []) as readonly TreeEntry[], repo.value));
    // Kick off `pnpm vitest run` for the given repo-relative dirs in a one-shot tmux panel session
    // (panel-<repo>--<session>). The daemon creates the session, so the caller pairs this with terminal.open to
    // attach — the terminal IS the result surface, like a dev server.
    const runTests = async (session: string, dirs: readonly string[]): Promise<void> => {
        await api.sandbox.json(`/workspace/repos/${encodeURIComponent(repo.value)}/tests`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ session, dirs }),
        });
    };
    return {
        projects,
        error: computed(() => (treeQuery.error.value ? treeQuery.error.value.message : null)),
        isLoading: treeQuery.isLoading,
        runTests,
    };
}
