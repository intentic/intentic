import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createBackoff } from "@intentic/base/async";
import { writeFileAtomic } from "@intentic/base/fs";
import {
    RUNNER_HEARTBEAT_MS,
    RUNNER_LINK_PATH,
    type RunnerLinkReading,
    runnerConnectUrl,
    runnerLinkReading,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
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

/* A RUNNER'S LONG OUTAGE RESTS A MINUTE, not the dial's quarter of an hour (2026-11-09). That rest is for a machine agent
   holding links to sandboxes that may be gone for good; a runner has one far end and exists for it alone, and the parent
   coming back (a restart, an update, a wake after its own sleep) is exactly when a turn is about to be dispatched. Past
   twenty failures (about eight minutes) the runner read offline for up to fifteen more after its parent was back. */
const RUNNER_LONG_OUTAGE_MS = 60_000;

// How often the link reading is written when nothing changes: its `at` is what tells a live daemon from a hung one.
const READING_EVERY_MS = 60_000;

// Never throws: a reading that cannot be written costs the keeper its look at the link, never the link.
const writeReading = async (path: string, reading: RunnerLinkReading): Promise<void> => {
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFileAtomic(path, `${JSON.stringify(reading)}\n`);
    } catch {
        // allow(silent-catch): /run/intentic is the container's; a daemon outside one has no keeper to tell
    }
};
// Dialled with ws rather than Node's own WebSocket, which reads deflated frames but never sends one: a runner's
// answers (a turn's events, a patch of up to 32 MiB, files of up to 8 MiB as base64) are most of what crosses this link,
// and the parent negotiates permessage-deflate on it (http/peer-deflate.ts).
// `working` is the work a restart would cut (bootstrap/working-now.ts, handed in by main.ts: runners/ reads nothing of bootstrap/).
export const startRunnerLink = (services: Services, identity: RunnerIdentity, working: () => number, readingPath = RUNNER_LINK_PATH): PeerLink => {
    const handler = new RPCHandler(createRunnerService(services, identity));
    let revoked = false;
    // Called only from the loop's callbacks, which it makes from its first dial on, never before dialPeer has returned
    // (that dial awaits `open`), and from the refresh below: `link` is always assigned by then.
    const publish = (): void =>
        void writeReading(readingPath, runnerLinkReading(link, identity.parentUrl, revoked, working(), Date.now()));
    const link = dialPeer<WebSocket>({
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
        longOutageMs: RUNNER_LONG_OUTAGE_MS,
        // Every line the loop says is a change of the link (connected, dropped, refused), so each is also a reading. The
        // "connected" line follows the hello, a moment after the socket opened.
        log: (message) => {
            services.logger.info({ parent: identity.parentUrl, id: identity.id }, `runner link: ${message}`);
            publish();
        },
        revoked: () => {
            revoked = true;
            publish();
            services.logger.error(
                { id: identity.id },
                "runner: the parent refused this runner's enrollment — it was revoked there. Re-pair from the parent sandbox and recreate this runner.",
            );
        },
    });
    publish();
    const refresh = setInterval(publish, READING_EVERY_MS);
    // A refresh must never hold the event loop open on its own.
    refresh.unref();
    void link.done.then(() => clearInterval(refresh));
    return link;
};
