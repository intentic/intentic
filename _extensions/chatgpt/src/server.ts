import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import { sandboxNameOf } from "./sandbox-name.js";
import { chatgptTools, type KitDeps } from "./served-tools.js";

// The backend (2026-11-26): the ChatGPT kit's three tools on this extension's own MCP server, run on the grants of the
// turn that calls them (extension API 2.55.0): a sandbox account's browser through `api.browser`, the person's own
// through `api.ownerBrowser`, and an image in the person's browser as a background job through `api.jobs`. The daemon
// held all of it in its browser tools and its peer door until then. Runs inside the daemon's extension host with node
// builtins and what it bundles.

/** The backend with its waits and the sandbox's name as given (tests shorten the one and name the other). */
export const chatgptBackend = (api: ExtensionServerApi, deps: Partial<Omit<KitDeps, "api">> = {}): ServerActivation => {
    api.tools.serve(() => chatgptTools({ ...deps, api, sandboxName: deps.sandboxName ?? (async () => await sandboxNameOf(api)) }));
    // Nothing to release: a call holds no listener, timer or process past its answer, and a job is the daemon's to end.
    // Declared anyway, so a change to this extension alone reloads it alone.
    return { deactivate: () => undefined };
};

export const activateServer = (api: ExtensionServerApi): ServerActivation => chatgptBackend(api);
