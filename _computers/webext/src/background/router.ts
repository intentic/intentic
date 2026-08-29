import { webextContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { handleMcpMessage } from "./mcp.js";
import { store } from "./store.js";
import { browserFacts, refreshBadge } from "./tools/access.js";

/* WHAT THIS BROWSER ANSWERS, as the oRPC SERVER on the socket it dialled out.
 *
 * The same inversion as a connected computer's: the extension placed the call, and the extension is also the
 * one being asked. oRPC's websocket adapter attaches a handler to any socket-like object, so which peer dialled
 * is independent of which peer serves — which is the only workable arrangement here, since nothing on the
 * internet can dial into a browser tab.
 *
 * `setScopes` writes through to storage rather than into a variable, and that is deliberate: an MV3 service
 * worker is killed after ~30 seconds of idleness and rebuilt on the next event, so a grant held in memory would
 * quietly revert to defaults several times an hour. Storage is the only thing here that outlives the worker. */
export const createWebExtRouter = (version: string) => {
    const os = implement(webextContract);
    return os.router({
        describe: os.describe.handler(async () => await browserFacts()),
        setScopes: os.setScopes.handler(async ({ input }) => {
            await store.setScopes(input);
            // The popup renders the switches, and the badge renders the pause state — both read from storage,
            // so a push that arrives while the popup is open should be visible without anyone clicking.
            await refreshBadge();
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure. Its payload is MCP, understood by handleMcpMessage and by the tool it
        // names, and deliberately not by the daemon in between (see the contract for why).
        mcp: os.mcp.handler(async ({ input }) => await handleMcpMessage(input, version)),
    });
};
