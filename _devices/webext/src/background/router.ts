import { webextContract } from "@intentic/sandbox-contract/webext";
import { implement } from "@orpc/server";
import { catchLoopback } from "./loopback-catch.js";
import { handleMcpMessage } from "./mcp.js";
import { store } from "./store.js";
import { browserFacts, refreshBadge } from "./tools/access.js";

// What this browser answers, as the oRPC server on the socket it dialled out: the extension both places the call
// and serves it, since nothing on the internet can dial into a browser tab. `setScopes` writes through to
// storage, not a variable, since an MV3 worker is killed and rebuilt every ~30s idle and storage is the only thing that
// outlives it.
export const createWebExtRouter = () => {
    const os = implement(webextContract);
    return os.router({
        describe: os.describe.handler(async () => await browserFacts()),
        setScopes: os.setScopes.handler(async ({ input }) => {
            await store.setScopes(input);
            // The popup and badge read from storage, so a push while the popup is open shows without a click.
            await refreshBadge();
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure: its payload is MCP, understood by handleMcpMessage and the tool it names,
        // deliberately
        // not by the daemon in between.
        mcp: os.mcp.handler(async ({ input }) => await handleMcpMessage(input, undefined)),
        // A sign-in's loopback redirect, watched for in this browser's tabs (loopback-catch.ts); armed by the sandbox
        // only, never a tool, so it is no page read the agent can reach for. Paused means paused for this too.
        catchLoopback: os.catchLoopback.handler(async function* ({ input, signal }) {
            if (await store.paused()) {
                yield { type: "busy" as const, reason: "this browser is paused" };
                return;
            }
            yield* catchLoopback(input, signal);
        }),
    });
};
