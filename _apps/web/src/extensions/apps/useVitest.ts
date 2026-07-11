import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../../composables/sandboxClient";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";

/* One repo's vitest projects, derived from the shared /workspace/tree cache (view-level — detect() stays on
 * daemon facts). A project is the nearest package.json dir owning vitest evidence: a vitest.config.* file OR
 * a *.test.* file — the config-less case is real (bare `vitest run` needs no config).
 * ponytail: assumes every *.test.* file in a vitest repo is a vitest test; read test scripts if a
 * mixed-runner repo ever shows up. */

const isEvidence = (name: string): boolean => name.startsWith(`vitest.config.`) || name.includes(`.test.`);

// Root-relative project dirs (e.g. "repositories/intentic/_libs/engine"), sorted; the repo root itself when
// evidence sits above any nested package.json.
export const vitestProjects = (tree: readonly WorkspaceTreeEntry[], repo: string): string[] => {
    const repoDir = tree.find((entry) => entry.name === `repositories`)?.children?.find((entry) => entry.name === repo);
    if (repoDir?.children === undefined) {
        return [];
    }
    const projects = new Set<string>();
    const walk = (dir: WorkspaceTreeEntry, pkg: string): void => {
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
    const { tree, root, error, isLoading } = useWorkspaceTree();
    const projects = computed(() => vitestProjects(tree.value, repo.value));
    // Kick off `pnpm vitest run` for the given repo-relative dirs in a one-shot tmux panel session
    // (panel-<repo>--<session>). The daemon creates the session, so the caller pairs this with
    // useTerminalPanel.openFocused to attach — the terminal IS the result surface, like a dev server.
    const runTests = async (session: string, dirs: readonly string[]): Promise<void> => {
        await sandboxJson(`/workspace/repos/${encodeURIComponent(repo.value)}/tests`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ session, dirs }),
        });
    };
    return { projects, root, error, isLoading, runTests };
}
