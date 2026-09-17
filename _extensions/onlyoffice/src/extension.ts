import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";

// Registers the one viewer: every office format the manifest claims opens in ONLYOFFICE Docs. The viewer is `edit`
// and `path`-fed, so it outranks the render-only office viewers and reads the file through its own backend.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(api.viewers.register({ id: `office`, component: async () => (await import(`./OnlyOfficeViewer.vue`)).default }));
};
