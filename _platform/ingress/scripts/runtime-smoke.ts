// Exercises the edge under bun, the runtime it actually ships on: vitest runs under node, and a node-only pass can hide
// a real bun failure (e.g. `ws`'s createWebSocketStream, unsupported in bun). Stands up both halves of a real tunnel
// over a real WebSocket and sends one request through; fails loudly if the runtime cannot do that.
import { openIngressSession, serveIngressSession, webSocketDuplex, type TunnelWebSocket } from "@intentic/sandbox-contract/ingress-protocol";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const BODY = `ingress-runtime-smoke`;
// A stuck handshake hangs rather than crashing; without this, CI just times out with no useful message.
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

// Stand-in for the sandbox's app, at the far end of the tunnel.
const target = createServer((_request, response) => {
    response.writeHead(200, { "content-type": `text/plain` });
    response.end(BODY);
});
const targetPort = await listen(target);

// One WebSocket, both halves bridged by the duplex under test.
const host = createServer();
const sockets = new WebSocketServer({ noServer: true });
host.on(`upgrade`, (request, socket, head) => {
    // Delayed on purpose: the real server awaits a revocation check before upgrading, so a smoke that upgrades
    // synchronously wouldn't catch a runtime that breaks only on a delayed upgrade.
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

// Edge's public face: every request is forwarded down the tunnel.
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
