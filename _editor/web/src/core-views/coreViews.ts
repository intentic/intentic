import type { ViewRegistration } from "@intentic/extension-api";

/* The CORE view contributions — first-party views that seed the runtime registry at module load but stay in the
 * app (not `_extensions/*` packages) because each is genuinely coupled to editor/platform internals a clean
 * extension must not reach:
 *   • infrastructure + live-status — straddle the PLATFORM (apiClient.sandbox.zones for Cloudflare provisioning),
 *     the app BUILD ENVIRONMENT (scriptCommand/environment for the connect/rebuild one-liners), dev tooling
 *     (devFill), and shared secret management. They are the editor↔platform/onboarding surface, not a daemon
 *     client, so extracting them would push platform+environment coupling into an extension.
 *   • directory-ui — its DirectoryUiHost sandboxed-iframe bridge is shared with the workspace file-open path.
 * Everything cleanly separable (logs, activity, automations, apps, preview) has moved to a package and is
 * activated through the public IntenticApi via extension-host/builtins.ts. These three consume privileged app
 * internals directly, by design. */

export const coreViews: readonly ViewRegistration[] = [
    {
        id: `infrastructure`,
        label: `Infrastructure`,
        surface: `rail`,
        // deploy.config.ts is the intent ledger's day-one marker (scaffolded before any deps land); the role
        // dir is the structural fallback for a ledger that predates/renames the marker.
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
        // A fresh desired-state repo carries NO content marker (desired-state.json appears after the first
        // resolve), so the role dir is the day-one evidence; the artifact takes over once it exists.
        //
        // `cloud`, not `sitemap`: this tile and Infrastructure's `server` are a matched pair — what you declared
        // versus what is actually up out there — and a reader who sees them together should be able to tell which
        // is which without hovering. `sitemap` said neither, and said it in the same shape as two other tiles.
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
        // A repo shipping its own sandboxed UI (.intentic/ui/index.html — the agent-authored Tier-2 surface).
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
        view: async () => (await import(`../pages/workspace/DirectoryUiHost.vue`)).default,
    },
];
