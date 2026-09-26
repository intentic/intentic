import type { ViewRegistration } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { MAINLINE_VIEW_ID, mainlineTileBadge } from "../features/agents/mainline/mainlineTile";

// Stay in-app rather than move to `_extensions/*`: each touches privileged internals a clean extension can't reach.
// - mainline: the fleet's roster (who landed what, who is fixing it) and the check's own work terminals.
// - infrastructure + live-status: platform (Cloudflare provisioning), build environment, secret management.
// - directory-ui: DirectoryUiHost's sandboxed-iframe bridge, shared with the workspace file-open path.
// - codebase-health: the index the daemon builds for the workspace, and the tab store it opens files through.
// Everything else separable has moved to a package, via extension-host/builtins.ts.

export const coreViews = (): readonly ViewRegistration[] => [
    {
        id: MAINLINE_VIEW_ID,
        label: t(`agents.mainline.title`),
        surface: `rail`,
        // Every sandbox's work lands and is checked, so there is no evidence to wait for; the tile holds a place on the
        // rail only while its badge says something (registry.ts, `signal`), and the view says when nothing was checked.
        detect: () => [{ key: MAINLINE_VIEW_ID, title: t(`agents.mainline.title`), icon: `mainline` }],
        badge: () => mainlineTileBadge.value,
        view: async () => (await import(`../features/agents/mainline/Mainline.vue`)).default,
    },
    {
        id: `infrastructure`,
        label: t(`views.words.infrastructure`),
        surface: `rail`,
        // deploy.config.ts is the ledger's day-one marker; the role dir is the fallback for a renamed one.
        detect: (repos) => {
            const intent = repos.find((repo) => repo.deployConfig || repo.role === `intent`);
            return intent === undefined ? [] : [{ key: intent.repo, title: t(`views.words.infrastructure`), icon: `server`, repo: intent.repo }];
        },
        view: async () => (await import(`./infrastructure/InfrastructureView.vue`)).default,
    },
    {
        id: `live-status`,
        label: t(`views.words.liveStatus`),
        surface: `rail`,
        // A fresh desired-state repo has no content marker until the first resolve, so the role dir is day-one
        // evidence. `cloud`, not `sitemap`, pairs it with Infrastructure's `server` (declared vs. actually up).
        detect: (repos) => {
            const target = repos.find((repo) => repo.role === `desired-state` || repo.desiredState);
            return target === undefined ? [] : [{ key: target.repo, title: t(`views.words.liveStatus`), icon: `cloud`, repo: target.repo }];
        },
        view: async () => (await import(`./live-status/LiveStatusView.vue`)).default,
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
