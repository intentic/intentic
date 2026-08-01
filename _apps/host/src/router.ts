import { type HostScopes, hostContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { rememberScopes } from "./config.js";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";

/* What this computer answers, as the oRPC SERVER on the socket it dialled out.
 *
 * The inversion is the interesting part: the machine placed the call, and the machine is also the one being
 * asked. That works because oRPC's websocket adapter attaches a handler to any socket-like object, so which peer
 * dialled is independent of which peer serves.
 *
 * `scopes` is a live reference, not a copy: `setScopes` replaces what the whole agent enforces, and the MCP
 * handler reads it per call — so a switch the owner turns off is in force on the very next tool call rather than
 * at the next reconnect. */
export interface HostRuntime {
    readonly scopes: () => HostScopes;
    readonly setScopes: (scopes: HostScopes) => void;
    readonly log: (message: string) => void;
}

export const createHostRouter = (runtime: HostRuntime) => {
    const os = implement(hostContract);
    return os.router({
        describe: os.describe.handler(async () => await hostFacts(runtime.scopes())),
        setScopes: os.setScopes.handler(({ input }) => {
            runtime.setScopes(input);
            runtime.log(`permissions updated: commands ${input.shell}, writes ${input.write}, screen ${input.screen}`);
            // The cache on disk is best-effort and deliberately not awaited into the answer: the live grant is
            // already enforcing, and a read-only disk must not make the sandbox think the push failed.
            void rememberScopes(input);
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure. Its payload is MCP, understood by handleMcpMessage and by the tool it names —
        // not by this contract, and deliberately not by the daemon (see the contract for why).
        mcp: os.mcp.handler(async ({ input }) => await handleMcpMessage(input, runtime.scopes)),
    });
};
