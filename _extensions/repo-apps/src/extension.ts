import type { Activation, ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-apps activation: bind the host handle, then register two directory views. */
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
