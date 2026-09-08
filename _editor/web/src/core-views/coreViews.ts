import type { ViewRegistration } from "@intentic/extension-api";

// Stay in-app rather than move to `_extensions/*`: each touches privileged internals a clean extension can't reach.
// - infrastructure + live-status: platform (Cloudflare provisioning), build environment, secret management.
// - directory-ui: DirectoryUiHost's sandboxed-iframe bridge, shared with the workspace file-open path.
// Everything else separable has moved to a package, via extension-host/builtins.ts.

export const coreViews: readonly ViewRegistration[] = [
    {
        id: `infrastructure`,
        label: `Infrastructure`,
        surface: `rail`,
        // deploy.config.ts is the ledger's day-one marker; the role dir is the fallback for a renamed one.
        detect: (repos) => {
            const intent = repos.find((repo) => repo.deployConfig || repo.role === `intent`);
            return intent === undefined ? [] : [{ key: intent.repo, title: `Infrastructure`, icon: `server`, repo: intent.repo }];
        },
        view: async () => (await import(`./infrastructure/InfrastructureView.vue`)).default,
    },
    {
        id: `live-status`,
        label: `Live status`,
        surface: `rail`,
        // A fresh desired-state repo has no content marker until the first resolve, so the role dir is day-one
        // evidence. `cloud`, not `sitemap`, pairs it with Infrastructure's `server` (declared vs. actually up).
        detect: (repos) => {
            const target = repos.find((repo) => repo.role === `desired-state` || repo.desiredState);
            return target === undefined ? [] : [{ key: target.repo, title: `Live status`, icon: `cloud`, repo: target.repo }];
        },
        view: async () => (await import(`./live-status/LiveStatusView.vue`)).default,
    },
    {
        id: `directory-ui`,
        label: `UI`,
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
