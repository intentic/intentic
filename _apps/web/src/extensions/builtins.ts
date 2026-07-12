import type { Activation, ViewRegistration } from "@intentic/extension-api";

/* Legacy compiled-in view contributions — the ones NOT YET moved into their own `_extensions/*` package. These
 * seed the runtime registry at module load; each still reaches privileged app internals (composables,
 * @intentic-app/ui, PrimeVue). As each migrates (extension-host/builtins.ts activates the packaged ones through
 * the public IntenticApi), its entry leaves this array. directory-ui is the exception that stays here
 * permanently: its DirectoryUiHost is shared with the workspace file-open path, so it's a core-registered view,
 * not a package. When only directory-ui remains, this file becomes the core view-contribution list. */

export const builtins: readonly ViewRegistration[] = [
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
        detect: (repos) => {
            const target = repos.find((repo) => repo.role === `desired-state` || repo.desiredState);
            return target === undefined ? [] : [{ key: target.repo, title: `Live status`, icon: `sitemap`, repo: target.repo }];
        },
        view: async () => (await import(`./live-status/LiveStatusView.vue`)).default,
    },
    {
        id: `apps`,
        label: `Apps`,
        surface: `directory`,
        // One tile per repo showing its apps AND their tests (the former `vitest` extension folded in — a
        // monorepo-with-vitest no longer gets a second, duplicate ⚡ tile). Two shapes:
        //   • A pnpm+turbo monorepo (EXCEPT the intent/infrastructure repo: deploy.config.ts can be committed
        //     into an app monorepo, so the intent repo may itself be a monorepo — it surfaces as
        //     Infrastructure, never a browsable app monorepo; same predicate as the infrastructure detector)
        //     claims its repo and gets props.monorepo, which renders the apps + Add-an-app affordances plus each
        //     app's nested tests, and suppresses the preview fallback.
        //   • Any OTHER repo with vitest evidence gets a tests-only tile: `repo` rides in props (NOT the
        //     activation), so a test view stays auxiliary and never claims the repo away from the preview
        //     fallback or the intent repo's Infrastructure tile.
        detect: (repos) =>
            repos.flatMap((repo): Activation[] => {
                if (repo.monorepo && !(repo.deployConfig || repo.role === `intent`)) {
                    return [{ key: repo.repo, title: repo.repo, repo: repo.repo, props: { monorepo: true } }];
                }
                if (repo.vitest) {
                    return [{ key: repo.repo, title: repo.repo, icon: `bolt`, props: { repo: repo.repo, monorepo: false } }];
                }
                return [];
            }),
        view: async () => (await import(`./apps/AppsView.vue`)).default,
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
                    props: { dir: `repositories/${repo.repo}` },
                })),
        view: async () => (await import(`../pages/workspace/DirectoryUiHost.vue`)).default,
    },
    {
        id: `preview`,
        label: `Preview`,
        surface: `directory`,
        // The raw dev-server iframe — the fallback for a plain runnable repo no first-party extension serves.
        fallback: true,
        detect: (repos) => repos.filter((repo) => repo.hasPanel).map((repo) => ({ key: repo.repo, title: repo.repo, repo: repo.repo })),
        view: async () => (await import(`../pages/Panel.vue`)).default,
    },
];
