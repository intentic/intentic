import { once } from "node:events";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { AnyRouter } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { WebSocket, WebSocketServer } from "ws";

// A live oRPC websocket link on loopback, wired as the hub and a peer are (peer-routes.ts, runner-link.ts): the client on
// the accepting side's socket, the peer dialling in and serving `router`. For tests that need the transport's own
// failures (a dropped socket, a send on a closed one, an unknown procedure) rather than a sentence written to look like one.
export interface OrpcLink<Client> {
    readonly client: Client;
    // The dialling side's socket: terminate it to drop the link under a call.
    readonly peer: WebSocket;
    readonly close: () => void;
}

export const orpcLink = async <Client>(router: AnyRouter): Promise<OrpcLink<Client>> => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address !== "object") {
        throw new Error("the websocket server answered no port");
    }
    const accepted = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
    // SAFETY: a `ws` socket has the DOM surface oRPC's adapters drive (addEventListener, send, readyState); its typings
    // only spell addEventListener's options more narrowly, as runner-link.ts and peer-routes.ts already cast for.
    new RPCHandler(router).upgrade(peer as unknown as Parameters<RPCHandler<object>["upgrade"]>[0]);
    await once(peer, "open");
    // SAFETY: as above, the accepting side's `ws` socket for the link.
    const link = new RPCLink({ websocket: (await accepted) as unknown as globalThis.WebSocket });
    // SAFETY: the caller names the client shape of the router it handed in; oRPC's proxy answers any path.
    const client = createORPCClient(link) as unknown as Client;
    return { client, peer, close: () => server.close() };
};

// The error a call settles with; a call that answers is the test's premise failing.
export const failureOf = async (call: Promise<unknown>): Promise<Error> => {
    const thrown = await call.then(
        () => undefined,
        (error: unknown) => error,
    );
    if (!(thrown instanceof Error)) {
        throw new Error(`the call settled with ${String(thrown)}`);
    }
    return thrown;
};
