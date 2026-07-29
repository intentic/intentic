import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-exploratory-tests activation: bind the host handle, then register one directory view for every repo that
 * describes its features as user stories (repo.userStories — a docs/user-stories directory).
 *
 * AUXILIARY, deliberately. The view runs tests against the repo's running app; it renders no preview of its
 * own, so claiming the repo — which is what suppresses the `preview` fallback tile — would cost exactly the
 * repos this extension is for (a dev server plus a stories directory) their Preview tab. Beside, not instead. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `exploratory-tests`,
            label: `Exploratory tests`,
            surface: `directory`,
            auxiliary: true,
            detect: (repos) =>
                repos.filter((repo) => repo.userStories).map((repo) => ({ key: repo.repo, title: repo.repo, icon: `list-check`, repo: repo.repo })),
            view: async () => (await import(`./ExploratoryView.vue`)).default,
        }),
    );
};
