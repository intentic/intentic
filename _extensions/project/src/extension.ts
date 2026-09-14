import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";

// The maker's home: one rail tile over the whole workspace. It activates whether or not a repository exists, since a
// workspace with nothing in it is where a maker starts, and the page's first job then is the ways in. The rail seats
// it where a developer has the file tree only for a maker (core-views/registry.ts); for everyone else it waits in the
// More menu, which is also where switching the extension off leaves nothing missing.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `project`,
            label: `Project`,
            surface: `rail`,
            detect: () => [{ key: `project`, title: `Project`, icon: `home` }],
            view: async () => (await import(`./ProjectView.vue`)).default,
        }),
        api.commands.register(`project.open`, () => {
            api.navigate(`/ext/project`);
        }),
    );
};
