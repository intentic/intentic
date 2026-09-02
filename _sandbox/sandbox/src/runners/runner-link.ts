import { createBackoff } from "@intentic/base/async";
import { runnerConnectUrl } from "@intentic/sandbox-contract";
import { RPCHandler } from "@orpc/server/websocket";
import type { Services } from "../composition.js";
import { emitDefinitionToml, settingsDefinition } from "../portability/definition.js";
import { version } from "../version.js";
import type { RunnerIdentity } from "./runner-identity.js";
import { createRunnerService } from "./runner-service.js";

/* THE ONE SOCKET a runner holds to its parent, the machine agent's connection loop retold inside the daemon
 * (_computers/machine/src/computer/connection.ts is the original, comment for comment where the reasoning
 * carries over).
 * Outbound only: the runner has no tunnel and no public name, so it can only ever be the side that dials,
 * and everything the parent asks arrives on this socket as oRPC against runnerContract.
 *
 * Reconnection is the normal case: lids close on the machines runners share, parents restart on rebuilds.
 * A dropped socket comes back on the shared exponential ladder (@intentic/base's createBackoff): a link that
 * held for a minute was working and its drop redials at the floor, one that opened and died at once keeps
 * climbing. The one close that is NOT retried is 1008, the parent refusing the enrollment, which only
 * re-pairing heals and which retrying would turn into log spam. */

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 60_000;
const UNAUTHORIZED = 1008;

export interface RunnerLink {
    readonly stop: () => void;
}

export const startRunnerLink = (services: Services, identity: RunnerIdentity): RunnerLink => {
    const handler = new RPCHandler(createRunnerService(services, identity));
    let stopped = false;
    let socket: WebSocket | undefined;
    let openedAt: number | undefined;
    const ladder = createBackoff({ floorMs: RETRY_MIN_MS, capMs: RETRY_MAX_MS, stableMs: STABLE_MS });

    const open = (): void => {
        const ws = new WebSocket(runnerConnectUrl(identity.parentUrl));
        socket = ws;
        ws.addEventListener("open", () => {
            openedAt = Date.now();
            // Handler before hello, the host agent's rule: the parent may call the moment the token verifies.
            handler.upgrade(ws as Parameters<RPCHandler<object>["upgrade"]>[0]);
            void (async () => {
                // The parity claim's settings half (runner-protocol.ts says what the parent does with it).
                // Best-effort: a settings store that cannot be read costs the drift lines, never the link.
                const definitionToml = await settingsDefinition(services)
                    .then((definition) => emitDefinitionToml(definition))
                    .catch(() => undefined);
                ws.send(
                    JSON.stringify({
                        type: "runner-hello",
                        token: identity.token,
                        version,
                        image: services.config.sandbox.image === "" ? "dev" : services.config.sandbox.image,
                        ...(services.config.sandbox.channel !== "" ? { channel: services.config.sandbox.channel } : {}),
                        ...(services.config.sandbox.environmentHash !== "" ? { overlayHash: services.config.sandbox.environmentHash } : {}),
                        ...(definitionToml !== undefined ? { definitionToml } : {}),
                    }),
                );
                services.logger.info({ parent: identity.parentUrl, id: identity.id }, "runner: connected to the parent");
            })();
        });
        ws.addEventListener("close", (event) => {
            socket = undefined;
            if (stopped) {
                return;
            }
            if (event.code === UNAUTHORIZED) {
                services.logger.error(
                    { id: identity.id },
                    "runner: the parent refused this runner's enrollment — it was revoked there. Re-pair from the parent sandbox and recreate this runner.",
                );
                stopped = true;
                return;
            }
            const delay = ladder.next(openedAt === undefined ? 0 : Date.now() - openedAt);
            openedAt = undefined;
            services.logger.warn({ code: event.code, delayMs: delay }, "runner: parent link dropped, reconnecting");
            setTimeout(open, delay);
        });
        ws.addEventListener("error", () => services.logger.warn({ parent: identity.parentUrl }, "runner: parent link error"));
    };

    open();
    return {
        stop: () => {
            stopped = true;
            socket?.close(1000, "stopping");
        },
    };
};
