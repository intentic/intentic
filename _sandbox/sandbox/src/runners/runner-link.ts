import { createBackoff } from "@intentic/base/async";
import { RUNNER_HEARTBEAT_MS, runnerConnectUrl } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import type { Services } from "../composition.js";
import { emitDefinitionToml, settingsDefinition } from "../portability/definition.js";
import { version } from "../version.js";
import type { RunnerIdentity } from "./runner-identity.js";
import { createRunnerService } from "./runner-service.js";

/* THE ONE SOCKET a runner holds to its parent: the peer dial (sandbox-contract's peer-dial.ts, the same loop
 * the machine agent and the browser extension run) inside the daemon. Outbound only: the runner has no tunnel
 * and no public name, so it can only ever be the side that dials, and everything the parent asks arrives on
 * this socket as oRPC against runnerContract. What is the runner's own is its hello, which carries the parity
 * claim (runner-protocol.ts says what the parent does with it). */
export const startRunnerLink = (services: Services, identity: RunnerIdentity): PeerLink => {
    const handler = new RPCHandler(createRunnerService(services, identity));
    return dialPeer<WebSocket>({
        open: async () => ({ socket: new WebSocket(runnerConnectUrl(identity.parentUrl)), said: `runner: connected to the parent ${identity.parentUrl} as "${identity.id}"` }),
        hello: async () => {
            // The parity claim's settings half. Best-effort: a settings store that cannot be read costs the drift
            // lines, never the link.
            const definitionToml = await settingsDefinition(services)
                .then((definition) => emitDefinitionToml(definition))
                .catch(() => undefined);
            return {
                type: "runner-hello",
                token: identity.token,
                version,
                image: services.config.sandbox.image === "" ? "dev" : services.config.sandbox.image,
                ...(services.config.sandbox.channel !== "" ? { channel: services.config.sandbox.channel } : {}),
                ...(services.config.sandbox.environmentHash !== "" ? { overlayHash: services.config.sandbox.environmentHash } : {}),
                ...(definitionToml !== undefined ? { definitionToml } : {}),
            };
        },
        attach: (ws) => handler.upgrade(ws as Parameters<RPCHandler<object>["upgrade"]>[0]),
        backoff: createBackoff(PEER_LINK_BACKOFF),
        /* A parent that went away without closing this socket leaves a runner that looks attached and answers
         * nothing — and unlike a device, nobody is watching a card for it, so silence is the only signal there
         * is. Timed off the parent's own heartbeat. */
        silenceMs: peerLinkSilenceMs(RUNNER_HEARTBEAT_MS),
        log: (message) => services.logger.info({ parent: identity.parentUrl, id: identity.id }, `runner link: ${message}`),
        revoked: () =>
            services.logger.error(
                { id: identity.id },
                "runner: the parent refused this runner's enrollment — it was revoked there. Re-pair from the parent sandbox and recreate this runner.",
            ),
    });
};
