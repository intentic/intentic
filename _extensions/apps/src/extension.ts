import type { Activation, ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-apps activation: bind the host handle, then register two directory views. "Apps" — one tile per repo,
 * two shapes: a pnpm+turbo monorepo (except the intent/infrastructure repo, which surfaces as Infrastructure)
 * claims its repo with props.monorepo; any other repo with vitest evidence gets a tests-only tile whose `repo`
 * rides in props so it stays auxiliary and never claims the repo away from the preview fallback.
 * "Dependencies" — the monorepo's workspace package graph, on the same monorepo predicate, surfacing as the
 * segmented tab next to Apps. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `apps`,
            label: `Apps`,
            surface: `directory`,
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
            view: async () => (await import(`./AppsView.vue`)).default,
        }),
        api.views.register({
            id: `dependencies`,
            label: `Dependencies`,
            surface: `directory`,
            detect: (repos) =>
                repos
                    .filter((repo) => repo.monorepo && !(repo.deployConfig || repo.role === `intent`))
                    .map((repo) => ({ key: repo.repo, title: repo.repo, repo: repo.repo })),
            view: async () => (await import(`./DependenciesView.vue`)).default,
        }),
    );
};
