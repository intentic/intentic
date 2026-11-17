import type { ViewRegistration } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { RUN_VIEW_ID } from "../workbench/views/registry";

// Stay in-app rather than move to `_extensions/*`: each touches privileged internals a clean extension can't reach.
// - directory-ui: DirectoryUiHost's sandboxed-iframe bridge, shared with the workspace file-open path.
// - run: the sandbox's live apps and the owner's computers' runs together (preview targets, device runs, terminals).
// - codebase-health: the index the daemon builds for the workspace, and the tab store it opens files through.
// Everything else separable has moved to a package, via extension-host/builtins.ts.

export const coreViews = (): readonly ViewRegistration[] => [
    {
        id: RUN_VIEW_ID,
        label: t(`run.view.title`),
        surface: `rail`,
        // Every workspace has one: what its repositories run and where, or, before any of them says, how to make one runnable.
        detect: () => [{ key: RUN_VIEW_ID, title: t(`run.view.title`), icon: `play` }],
        view: async () => (await import(`../features/run/RunView.vue`)).default,
    },
    {
        id: `codebase-health`,
        label: t(`views.coreViews.health`),
        surface: `directory`,
        // Auxiliary: every repository has a report, so claiming them would starve views that serve unclaimed repos.
        auxiliary: true,
        // The workspace root is absent from discovery and has no tree row; its report opens from the toolbar instead.
        detect: (repos) => repos.map((repo) => ({ key: repo.repo, title: t(`views.coreViews.health`), repo: repo.repo })),
        view: async () => (await import(`../features/workspace/health/CodebaseHealth.vue`)).default,
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
