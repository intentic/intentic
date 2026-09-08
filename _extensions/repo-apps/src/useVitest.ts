import { WorkspaceTreeSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

// Tree shape for walking: zod's getter-form recursion in WorkspaceTreeSchema infers `children` too loosely, so parsed
// data is cast to this explicit interface instead.
export interface TreeEntry {
    readonly name: string;
    readonly path: string;
    readonly type: "file" | "dir";
    readonly children?: readonly TreeEntry[];
}

// One repo's vitest projects, derived from the shared /workspace/tree cache. A project is the nearest package.json dir
// with vitest evidence (a vitest.config.* or *.test.* file; config-less is real). Shares the editor file tree's cache
// key, so both dedupe to one fetch.

const isEvidence = (name: string): boolean => name.startsWith(`vitest.config.`) || name.includes(`.test.`);

// Root-relative project dirs, sorted (repo root itself if evidence sits above any nested package.json). The repo id is
// a root-relative path, so its tree node is found by descending one segment per path component.
export const vitestProjects = (tree: readonly TreeEntry[], repo: string): string[] => {
    let repoDir: TreeEntry | undefined;
    let level: readonly TreeEntry[] = tree;
    for (const segment of repo.split(`/`)) {
        repoDir = level.find((entry) => entry.name === segment);
        level = repoDir?.children ?? [];
    }
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
    // Kicks off `pnpm vitest run` for these dirs in a one-shot tmux session (panel-<repo>--<session>); pair with
    // terminal.open to attach, since the terminal is the result surface.
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
