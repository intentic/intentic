import type { Services } from "../../composition.js";
import { profileOwner } from "../sessions/session-store.js";
import { type BrowserRouterFactory, createBrowserRouter, type Prepared, type RouterDeps } from "./browser-router.js";
import { ANONYMOUS_BROWSER_SERVER, browserToolSchemas, prepareBrowserOwner } from "./browser-tools.js";

// The daemon's side of every turn's browser routers: bringing one owner up on the first call that names it. The routers
// run here rather than as a process per session since display allocation, fingerprints, exits and profile locks are all
// this process's state anyway.

// Second gate, not the only one: a turn's manifest already limits which owners its router may ask for, and this limits
// the ask to profiles the sandbox actually holds, so no manifest can name a path.
export const prepareKnownOwner = async (services: Pick<Services, "capabilities" | "workspace">, owner: string, port: number): Promise<Prepared> => {
    const capabilities = await services.capabilities.list();
    const known =
        owner === ANONYMOUS_BROWSER_SERVER ||
        capabilities.some((capability) => (capability.kind === "browser" || capability.kind === "identity") && profileOwner(capability) === owner);
    if (!known) {
        return { refusal: `no browser profile named "${owner}" in this sandbox` };
    }
    return prepareBrowserOwner(capabilities, services.workspace.root, owner, port);
};

// Every turn's router is made here and mounted by the turn (browser-tools.ts), which reaches it at the daemon's one MCP
// door. Services are read lazily, since the factory is one of them.
export const createBrowserRouters = (services: () => Pick<Services, "capabilities" | "workspace">): BrowserRouterFactory => {
    const deps: RouterDeps = { toolSchemas: browserToolSchemas, prepare: (owner, port) => prepareKnownOwner(services(), owner, port) };
    return (manifest) => createBrowserRouter(manifest, deps);
};
