import type { ViewRegistration } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { RUN_VIEW_ID } from "../workbench/views/registry";

// Stay in-app rather than move to `_extensions/*`: each touches privileged internals a clean extension can't reach.
// - directory-ui: DirectoryUiHost's sandboxed-iframe bridge, shared with the workspace file-open path.
// - run: the sandbox's live apps and the owner's computers' runs together (preview targets, device runs, terminals).
// Everything else separable has moved to a package, via extension-host/builtins.ts.

export const coreViews = (): readonly ViewRegistration[] => [
    {
        id: RUN_VIEW_ID,
        label: t(`run.view.title`),
        surface: `rail`,
        // A workspace with software in it: at least one repository (a git repository, or a workspace root Start can run).
        // There it says what runs and where, or, before any repository says, how to make one runnable. A workspace of
        // documents alone has nothing to run and nothing to make runnable, so it gets no Run tile.
        detect: (repos) => (repos.length === 0 ? [] : [{ key: RUN_VIEW_ID, title: t(`run.view.title`), icon: `play` }]),
        view: async () => (await import(`../features/run/RunView.vue`)).default,
    },
    {
        id: `directory-ui`,
        label: t(`views.coreViews.ui`),
        surface: `directory`,
        // A repo shipping its own sandboxed UI (.intentic/ui/index.html, the agent-authored Tier-2 surface).
        detect: (repos) =>
            repos
                .filter((repo) => repo.directoryUi)
                .map((repo) => ({
                    key: repo.repo,
                    title: repo.repo,
                    icon: `sparkles`,
                    repo: repo.repo,
                    props: { dir: repo.repo },
                })),
        view: async () => (await import(`../features/workspace/directory-ui/DirectoryUiHost.vue`)).default,
    },
];
