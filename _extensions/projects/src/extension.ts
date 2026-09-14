import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";

// The workspace's repositories as a dashboard: one rail tile, activating whether or not a repository exists yet,
// since a workspace with none is where a maker starts and the dashboard's first tile is then New project. The rail
// seats it where a developer has the file tree only for a maker (core-views/registry.ts); for everyone else it waits
// in the More menu, which is also where switching the extension off leaves nothing missing.
// The tile is also where the shell says which project it is looking at: the title carries the name and the badge's
// mark says a scope is on, so every other area's narrowing has a visible cause one glance away.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `projects`,
            label: `Projects`,
            surface: `rail`,
            detect: () => {
                const project = api.workspace.project();
                return [{ key: `projects`, title: project === undefined ? `Projects` : `Projects · ${project}`, icon: `th-large` }];
            },
            badge: () => {
                const project = api.workspace.project();
                return project === undefined ? undefined : { mark: `folder-open`, tone: `neutral`, tooltip: `looking at ${project} only` };
            },
            view: async () => (await import(`./ProjectsView.vue`)).default,
        }),
        api.commands.register(`projects.open`, () => {
            api.navigate(`/ext/projects`);
        }),
    );
};
