import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";
import { monogramOf } from "./projects.js";
import { t } from "./i18n.js";

// The workspace's repositories as a dashboard: one rail tile, activating whether or not a repository exists yet,
// since a workspace with none is where a maker starts and the dashboard's first tile is then New project. The rail
// seats it at its head for everyone (core-views/registry.ts), above what its scope narrows; for a maker the file
// tree stands in when the extension is off, so switching it off leaves nothing missing.
// The tile is also where the shell says which project it is looking at: it wears the project's monogram in place of
// its glyph and the title carries the name, so every other area's narrowing has a visible cause one glance away.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `projects`,
            label: t(`extension.projects`),
            surface: `rail`,
            detect: () => {
                const project = api.workspace.project();
                return project === undefined
                    ? [{ key: `projects`, title: t(`extension.projects`), icon: `th-large` }]
                    : [{ key: `projects`, title: t(`extension.projects2`, { project }), icon: `th-large`, monogram: monogramOf(project) }];
            },
            badge: () => {
                const project = api.workspace.project();
                return project === undefined ? undefined : { tooltip: t(`extension.lookingAtOnly`, { project }) };
            },
            view: async () => (await import(`./ProjectsView.vue`)).default,
        }),
    );
};
