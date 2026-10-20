import { createBackoff } from "@intentic/base/async";
import { RUNNER_HEARTBEAT_MS, runnerConnectUrl } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { WebSocket } from "ws";
import type { Services } from "../composition.js";
import { PEER_DEFLATE } from "../http/peer-deflate.js";
import { emitDefinitionToml, settingsDefinition } from "../definition/definition.js";
import { runningBuild } from "../environment/overlay.js";
import { opt } from "../opt.js";
import { version } from "../version.js";
import type { RunnerIdentity } from "./runner-identity.js";
import { createRunnerService } from "./runner-service.js";

/* A runner holds one parent socket through the sandbox-contract peer dial. */
// Dialled with ws rather than Node's own WebSocket, which reads deflated frames but never sends one: a runner's
// answers (a turn's events, a patch of up to 32 MiB, files of up to 8 MiB as base64) are most of what crosses this link,
// and the parent negotiates permessage-deflate on it (http/peer-deflate.ts).
export const startRunnerLink = (services: Services, identity: RunnerIdentity): PeerLink => {
    const handler = new RPCHandler(createRunnerService(services, identity));
    return dialPeer<WebSocket>({
        open: async () => ({
            socket: new WebSocket(runnerConnectUrl(identity.parentUrl), { perMessageDeflate: PEER_DEFLATE }),
            said: `runner: connected to the parent ${identity.parentUrl} as "${identity.id}"`,
        }),
        hello: async () => {
            // The parity claim's settings half. Best-effort: a settings store that cannot be read costs the drift
            // lines, never the link.
            const definitionToml = await settingsDefinition(services)
                .then((definition) => emitDefinitionToml(definition))
                .catch(() => undefined);
            const build = runningBuild(services.config.sandbox);
            return {
                type: "runner-hello",
                token: identity.token,
                version,
                image: services.config.sandbox.image === "" ? "dev" : services.config.sandbox.image,
                ...opt("baseImage", build.base === "" ? undefined : build.base),
                ...opt("baseDigest", build.baseDigest),
                ...opt("channel", services.config.sandbox.channel === "" ? undefined : services.config.sandbox.channel),
                ...opt("overlayHash", build.overlay),
                ...opt("definitionToml", definitionToml),
            };
        },
        attach: (ws) => handler.upgrade(ws as Parameters<RPCHandler<object>["upgrade"]>[0]),
        backoff: createBackoff(PEER_LINK_BACKOFF),
        /* A silent parent socket must expire so a runner cannot remain falsely attached. */
        silenceMs: peerLinkSilenceMs(RUNNER_HEARTBEAT_MS),
        log: (message) => services.logger.info({ parent: identity.parentUrl, id: identity.id }, `runner link: ${message}`),
        revoked: () =>
            services.logger.error(
                { id: identity.id },
                "runner: the parent refused this runner's enrollment — it was revoked there. Re-pair from the parent sandbox and recreate this runner.",
            ),
    });
};
