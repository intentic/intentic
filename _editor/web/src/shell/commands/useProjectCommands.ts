import type { Disposable } from "@intentic/extension-api";
import { computed, onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { projectScope, setProjectScope } from "../../app/projectScope";
import { projectIdsOf } from "../../features/workspace/explorer/projectFocus";
import { useRepos } from "../../features/workspace/explorer/useRepos";
import { PROJECT } from "../../workbench/commands/categories";
import { registerCommand } from "../../workbench/commands/useCommands";
import { t } from "@intentic/ui/i18n";

// The project scope (app/projectScope.ts) by keyboard: "Project: Show only shop" for every repository under the workspace
// root but the open one, and "Project: Show every project" while one is open. The mouse's way to the same choice is the
// file tree's menu (features/workspace/explorer/projectFocus.ts); neither needs a rail tile.

export interface ProjectCommand {
    readonly command: string;
    readonly title: string;
    readonly icon: string;
    readonly project: string | undefined;
}

export const projectCommands = (projects: ReadonlySet<string>, current: string | undefined): readonly ProjectCommand[] => [
    ...(current === undefined ? [] : [{ command: `project.showAll`, title: t(`workspace.workspaceScopeNote.showEverything`), icon: `th-large`, project: undefined }]),
    ...[...projects]
        .filter((id) => id !== current)
        .toSorted((left, right) => left.localeCompare(right))
        .map((id) => ({ command: `project.focus.${id}`, title: t(`shell.useProjectCommands.showOnly`, { project: id }), icon: `filter`, project: id })),
];

export function useProjectCommands(): void {
    const { all } = useRepos();
    const list = computed(() => projectCommands(projectIdsOf(all.value), projectScope.value));

    let disposables: readonly Disposable[] = [];
    const release = (): void => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    };
    const sync = (entries: readonly ProjectCommand[]): void => {
        release();
        disposables = entries.map((entry) =>
            registerCommand({
                owner: `builtin`,
                command: entry.command,
                title: entry.title,
                category: PROJECT,
                icon: entry.icon,
                handler: () => setProjectScope(entry.project),
            }),
        );
    };

    // From onMounted, as the navigation commands are, since the shell may discard an instance before it mounts.
    let stop: WatchStopHandle | undefined;
    onMounted(() => {
        stop = watch(list, sync, { immediate: true });
    });
    onUnmounted(() => {
        stop?.();
        stop = undefined;
        release();
    });
}
