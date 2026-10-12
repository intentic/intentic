import { errorMessage } from "@intentic/base/errors";
import type { Services } from "../../composition.js";
import { browserOutputDir } from "../cast/browser-artifacts.js";
import { toolCallIdOf, writeScreenshotProvenance } from "../cast/screenshot-provenance.js";
import { browserAccountPage } from "../sessions/browser-sessions.js";
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
// `logger` is optional only so a caller handing just the two stores still compiles; without it a sidecar that failed
// is said nowhere.
export const createBrowserRouters = (services: () => Pick<Services, "capabilities" | "workspace"> & Partial<Pick<Services, "logger">>): BrowserRouterFactory => {
    const deps: RouterDeps = {
        toolSchemas: browserToolSchemas,
        prepare: (owner, port) => prepareKnownOwner(services(), owner, port),
        // A sidecar that could not be written costs the shot nothing; the agent already has its answer.
        screenshotTaken: (shot) => {
            void writeScreenshotProvenance({
                outputDir: browserOutputDir(services().workspace.root),
                browser: shot.owner,
                answer: shot.answer,
                conversationId: shot.conversationId,
                toolCallId: toolCallIdOf(shot.params),
                page: browserAccountPage(shot.owner),
            }).catch((error: unknown) =>
                services().logger?.warn({ conversationId: shot.conversationId, reason: errorMessage(error) }, "browser: screenshot provenance not written"),
            );
        },
    };
    return (manifest) => createBrowserRouter(manifest, deps);
};
