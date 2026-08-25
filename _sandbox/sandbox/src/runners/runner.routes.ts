import { upgradeWebSocket } from "@hono/node-server";
import { RunnerHelloSchema, type RunnerSummary } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { Services } from "../composition.js";
import type { RunnerClient } from "./runner-hub.js";

/* The parent-side doors of a runner (docs/remote-runners-plan.md, workspace root):
 *
 *   /system/runners/connect  the runner's own WebSocket, authenticated by its first frame (runner-protocol.ts
 *                            says why it is a frame and not a URL), then handed to the oRPC link.
 *   /system/runners/enroll   redeems its one-time pairing for the durable token — app.ts, beside the hosts'.
 *
 * The host connect route's shape, because the problem is the same: a socket arrives anonymous, has seconds to
 * say whose it is, and from the hello on every byte belongs to the typed link. */

// How long a freshly-opened socket may stay anonymous. It has exactly one job in that window.
const AUTH_DEADLINE_MS = 10_000;

export const createRunnerConnectRoute = (services: Services) =>
    upgradeWebSocket(() => {
        let detach: (() => void) | undefined;
        let deadline: NodeJS.Timeout | undefined;

        return {
            onOpen: (_event, ws) => {
                deadline = setTimeout(() => {
                    if (detach === undefined) {
                        ws.close(1008, "unauthorized");
                    }
                }, AUTH_DEADLINE_MS);
            },
            // The ONLY message this handler ever reads is the hello; a second one is a stray frame the link
            // rejects on its own (host.routes.ts's reasoning, unchanged).
            onMessage: async (event, ws) => {
                if (detach !== undefined) {
                    return;
                }
                const hello = RunnerHelloSchema.safeParse(JSON.parse(String(event.data ?? "")));
                if (!hello.success) {
                    services.logger.warn({ err: hello.error }, "runner: first frame was not a hello");
                    ws.close(1008, "unauthorized");
                    return;
                }
                const id = await services.runners.verify(hello.data.token);
                if (id === undefined) {
                    services.logger.warn("runner: rejected an unenrolled token");
                    ws.close(1008, "unauthorized");
                    return;
                }
                clearTimeout(deadline);
                // node-server hands the real socket on `.raw`, which carries the surface oRPC's link needs.
                const socket = ws.raw as unknown as WebSocket;
                const client: RunnerClient = createORPCClient(new RPCLink({ websocket: socket }));
                detach = services.runnerHub.attach(id, {
                    client,
                    close: (code, reason) => ws.close(code, reason),
                    parity: {
                        version: hello.data.version,
                        image: hello.data.image,
                        ...(hello.data.channel !== undefined ? { channel: hello.data.channel } : {}),
                        ...(hello.data.overlayHash !== undefined ? { overlayHash: hello.data.overlayHash } : {}),
                    },
                });
                services.runnerHub.observe(id, await client.describe());
            },
            onClose: () => {
                clearTimeout(deadline);
                detach?.();
            },
            onError: (event) => {
                services.logger.warn({ event: String(event) }, "runner: socket error");
            },
        };
    });

// The owner's view: every enrolled runner, with whatever the hub knows about it right now. "Enrolled but
// never connected" must be distinguishable from "connected but asleep", the hosts view's rule.
export const runnerSummaries = async (services: Services): Promise<RunnerSummary[]> =>
    (await services.runners.ids()).map((id) => ({ id, ...services.runnerHub.state(id) }));
