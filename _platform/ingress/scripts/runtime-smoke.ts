/* THE EDGE, EXERCISED ON THE RUNTIME IT ACTUALLY SHIPS ON. `pnpm test` runs this under bun after vitest,
 * because vitest runs under node and the image runs `bun src/main.ts` — and that gap is not theoretical:
 * `ws`'s `createWebSocketStream`, which the tunnel used to be built on, throws "Not supported yet in Bun"
 * from its own constructor. Every unit test passed, the image built, and the FIRST sandbox to register a
 * tunnel killed the process — then again on its retry, so the whole fabric stayed down while every test in
 * the repository was green. ci.yml's own words for this shape are "a package shipped by a pipeline it is not
 * verified by is a package that can ship broken".
 *
 * So this asserts nothing clever. It stands up both halves of a real tunnel over a real WebSocket, sends one
 * request through it, and fails loudly if the runtime cannot do that — which is the single thing the unit
 * tests cannot tell us, because they are not running where it matters. */
import { openIngressSession, serveIngressSession, webSocketDuplex, type TunnelWebSocket } from "@intentic/sandbox-contract/ingress-protocol";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const BODY = `ingress-runtime-smoke`;
/* A RUNTIME THAT CANNOT UPGRADE DOES NOT ALWAYS CRASH — on some builds the handshake simply never completes
 * and the tunnel hangs, which in CI is a job that runs until the runner's own timeout kills it and says
 * nothing useful. A watchdog turns that into a named failure. */
const watchdog = setTimeout(() => {
    console.error(
        `ingress runtime smoke FAILED: the tunnel never came up within 30s on ` +
            `${process.versions.bun === undefined ? `node ${process.versions.node}` : `bun ${process.versions.bun}`}.\n` +
            `If this is bun, the likely cause is the upgrade-after-await bug: every RELEASED bun (1.4.0 and ` +
            `earlier) aborts a WebSocket handshake completed a tick after the 'upgrade' event, which is what ` +
            `this edge does — it awaits the platform's revocation answer first. Fixed on bun main; this ` +
            `package pins a canary for exactly that reason (see its Dockerfile and its bun devDependency).`,
    );
    process.exit(1);
}, 30_000);
watchdog.unref?.();
const fail = (why: string): never => {
    console.error(`ingress runtime smoke FAILED on ${process.versions.bun === undefined ? `node` : `bun ${process.versions.bun}`}: ${why}`);
    process.exit(1);
};
const listen = async (server: ReturnType<typeof createServer>): Promise<number> =>
    new Promise((resolve) => server.listen(0, `127.0.0.1`, () => resolve((server.address() as { port: number }).port)));

// The sandbox's own app, at the far end of the tunnel.
const target = createServer((_request, response) => {
    response.writeHead(200, { "content-type": `text/plain` });
    response.end(BODY);
});
const targetPort = await listen(target);

// One WebSocket, both halves bridged by the duplex this exists to prove.
const host = createServer();
const sockets = new WebSocketServer({ noServer: true });
host.on(`upgrade`, (request, socket, head) => {
    /* THE AWAIT IS THE POINT, not incidental setup. server.ts asks the platform whether the sandbox still
     * exists BEFORE it upgrades — that round trip is the whole of revocation — so the upgrade always
     * completes one or more ticks after the `upgrade` event. bun 1.4.0 cannot do that: the handshake is
     * aborted and its abort path then dies on `STATUS_CODES` being undefined, killing the edge. A smoke that
     * upgraded synchronously passed on the exact build that was crash-looping in production, so it has to
     * wait here or it is testing a code path the edge does not have. */
    void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit(`connection`, ws));
    })();
});
const tunnelPort = await listen(host);

const edgeSide = new Promise<WebSocket>((resolve) => sockets.once(`connection`, resolve));
const daemonSide = new WebSocket(`ws://127.0.0.1:${tunnelPort}/tunnel/v1`);
await new Promise<void>((resolve, reject) => {
    daemonSide.once(`open`, () => resolve());
    daemonSide.once(`error`, reject);
});

const served = await serveIngressSession(webSocketDuplex(daemonSide as unknown as TunnelWebSocket), { targetPort });
const session = await openIngressSession(webSocketDuplex((await edgeSide) as unknown as TunnelWebSocket));

// The edge's public face: every request is forwarded down the tunnel.
const edge = createServer((request, response) => {
    session.forwardRequest(request, response).catch(() => {
        if (!response.headersSent) {
            response.writeHead(502);
        }
        response.end();
    });
});
const edgePort = await listen(edge);

const answer = await fetch(`http://127.0.0.1:${edgePort}/`).then(async (r) => r.text());
if (answer !== BODY) {
    fail(`a request through the tunnel returned ${JSON.stringify(answer)}, expected ${JSON.stringify(BODY)}`);
}

served.close();
session.close();
edge.close();
host.close();
target.close();
console.log(`ingress runtime smoke ok on ${process.versions.bun === undefined ? `node` : `bun ${process.versions.bun}`}`);
process.exit(0);
