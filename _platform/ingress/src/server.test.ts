import { INGRESS_GRANT_HEADER, mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { serveIngressSession, type IngressSessionServer } from "@intentic/sandbox-contract/ingress-protocol";
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as h1Request, type Server } from "node:http";
import { type AddressInfo, connect as netConnect } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";
import type { Reachability } from "./revocation.js";
import { createIngressServer, REPLAY_CACHE_TTL_SECS, type IngressServer } from "./server.js";

/* THE EDGE, DRIVEN THE WAY A BROWSER AND A CONTAINER ACTUALLY DRIVE IT — a real socket dialling the real
 * tunnel door, and real HTTP requests routed by real Host headers.
 *
 * The pieces are unit-tested next door; what only an end-to-end run can show is that the two halves agree:
 * that a grant this key signs is one the edge accepts, that a request for `sandbox-<id>` comes out of the
 * daemon-side session with its Host intact (which is the whole of how a container tells its own address apart
 * from a preview's), and that the refusals are refusals rather than hangs.
 */

const SANDBOX_ID = `abcdef012345`;
const ZONE = `sbx.example.test`;
const OTHER_ID = `0123456789ab`;

const keys = generateKeyPairSync(`ed25519`);
const privateKey = keys.privateKey.export({ type: `pkcs8`, format: `pem` }).toString();
const publicKey = keys.publicKey.export({ type: `spki`, format: `pem` }).toString();

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

// One request through the edge, with a Host of the test's choosing — which `fetch` will not allow and is the
// only input that decides routing here.
const get = (port: number, host: string, path = `/`): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const request = h1Request({ host: `127.0.0.1`, port, path, headers: { host } }, (response) => {
            const chunks: Buffer[] = [];
            response.on(`data`, (chunk: Buffer) => chunks.push(chunk));
            response.on(`end`, () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(`utf8`) }));
        });
        request.on(`error`, reject);
        request.end();
    });

describe(`the ingress edge`, () => {
    let target: Server;
    let ingress: IngressServer;
    let socket: WebSocket | undefined;
    let daemon: IngressSessionServer | undefined;

    beforeAll(async () => {
        // The container's front door: answers with the Host it was reached by, which is what the daemon-side
        // dispatch reads and therefore the one thing worth proving survives the hop.
        target = createServer((request, response) => {
            response.writeHead(200, { "content-type": `text/plain` });
            response.end(`served ${request.headers.host}${request.url}`);
        });
        await new Promise<void>((resolve) => target.listen(0, `127.0.0.1`, resolve));

        ingress = createIngressServer({
            publicKey,
            revocation: { allows: () => Promise.resolve(true), lookup: () => Promise.resolve({ exists: true, lane: `tunnel` }) },
            log: () => undefined,
        });
        await ingress.listen(0, `127.0.0.1`);
    });

    afterAll(async () => {
        daemon?.close();
        socket?.terminate();
        await ingress.close();
        await new Promise<void>((resolve) => target.close(() => resolve()));
    });

    test(`answers its own health on a host that names no sandbox`, async () => {
        const answer = await get(portOf(ingress.server), `ingress.${ZONE}`, `/health`);
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toMatchObject({ status: `ok` });
    });

    test(`404s a stray subdomain the wildcard also catches`, async () => {
        const answer = await get(portOf(ingress.server), `nothing.${ZONE}`);
        expect(answer.status).toBe(404);
    });

    /* 502 RATHER THAN 404, and the body names the label. The browser's availability flow reads any 5xx as
     * "the sandbox is unreachable" and drives the wake; a 404 reads as "no such thing" and stops it. */
    test(`502s a sandbox with no tunnel, naming its address`, async () => {
        const answer = await get(portOf(ingress.server), `sandbox-${SANDBOX_ID}.${ZONE}`);
        expect(answer.status).toBe(502);
        expect(answer.body).toContain(`sandbox-${SANDBOX_ID}`);
    });

    test(`refuses a tunnel that presents no grant`, async () => {
        const refused = new WebSocket(`ws://127.0.0.1:${portOf(ingress.server)}/tunnel/v1`);
        const error = await new Promise<string>((resolve) => {
            refused.on(`unexpected-response`, (_request, response) => resolve(String(response.statusCode)));
            refused.on(`error`, (err) => resolve(err.message));
        });
        expect(error).toContain(`401`);
    });

    test(`refuses a grant signed by somebody else`, async () => {
        const stranger = generateKeyPairSync(`ed25519`).privateKey.export({ type: `pkcs8`, format: `pem` }).toString();
        const forged = mintReachabilityGrant(stranger, SANDBOX_ID, Date.now());
        const refused = new WebSocket(`ws://127.0.0.1:${portOf(ingress.server)}/tunnel/v1`, {
            headers: { [INGRESS_GRANT_HEADER]: forged },
        });
        const error = await new Promise<string>((resolve) => {
            refused.on(`unexpected-response`, (_request, response) => resolve(String(response.statusCode)));
            refused.on(`error`, (err) => resolve(err.message));
        });
        expect(error).toContain(`401`);
    });

    /* THE WHOLE CHAIN. A container dials, presents a grant the platform signed, and from then on its own
     * hostname is served out of its own process. */
    test(`registers a validly-signed tunnel and routes the sandbox's hostname down it`, async () => {
        const grant = mintReachabilityGrant(privateKey, SANDBOX_ID, Date.now());
        socket = new WebSocket(`ws://127.0.0.1:${portOf(ingress.server)}/tunnel/v1`, {
            headers: { [INGRESS_GRANT_HEADER]: grant },
        });
        await new Promise<void>((resolve, reject) => {
            socket?.on(`open`, () => resolve());
            socket?.on(`error`, reject);
        });
        daemon = await serveIngressSession(createWebSocketStream(socket), { targetPort: portOf(target) });
        // Registration completes on the edge's own microtask queue, a moment after the socket opens.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        expect(ingress.registry.ids()).toEqual([SANDBOX_ID]);

        const answer = await get(portOf(ingress.server), `sandbox-${SANDBOX_ID}.${ZONE}`, `/health`);
        expect(answer.status).toBe(200);
        // The Host survives the whole hop: that is what lets one tunnel serve a daemon and its previews.
        expect(answer.body).toBe(`served sandbox-${SANDBOX_ID}.${ZONE}/health`);
    });

    // Every public name a sandbox serves ends in its own id, so a preview rides the same registration with no
    // second name to claim anywhere.
    test(`routes a preview hostname down the same tunnel`, async () => {
        const answer = await get(portOf(ingress.server), `preview-web-${SANDBOX_ID}.${ZONE}`, `/`);
        expect(answer.status).toBe(200);
        expect(answer.body).toBe(`served preview-web-${SANDBOX_ID}.${ZONE}/`);
    });

    // Ownership is a parse, so a host carrying somebody else's id can never reach this tunnel.
    test(`will not route another sandbox's hostname down this tunnel`, async () => {
        const answer = await get(portOf(ingress.server), `sandbox-${OTHER_ID}.${ZONE}`);
        expect(answer.status).toBe(502);
    });
});

/* THE EDGE AS A ROUTER. A hosted sandbox is a Fly app in the same org and dials no tunnel; a request for its
 * hostname is answered with the headers that make Fly's proxy deliver the request to that app — and keep
 * doing so for the hostname without asking again. What these pin is the decision: which ids are replayed,
 * to which app, and that a sandbox on somebody's own machine still gets the 502 its wake flow reads. The
 * proxy's half (carrying the bytes) is Fly's, and is proved against Fly rather than here. */
describe(`the ingress edge replaying hosted sandboxes`, () => {
    const HOSTED_ID = `feedfacecafe`;
    const NAMED_ID = `0badf00dbeef`;
    const UNKNOWN_ID = `abcdef000000`;
    const GONE_ID = `deadbeef0000`;
    const lanes: Record<string, Reachability> = {
        [HOSTED_ID]: { exists: true, lane: `hosted` },
        [NAMED_ID]: { exists: true, lane: `hosted`, app: `renamed-app` },
        [SANDBOX_ID]: { exists: true, lane: `tunnel` },
        [UNKNOWN_ID]: { exists: true },
        [GONE_ID]: { exists: false },
    };
    let router: IngressServer;

    beforeAll(async () => {
        router = createIngressServer({
            publicKey,
            revocation: { allows: () => Promise.resolve(true), lookup: (id) => Promise.resolve(lanes[id] ?? { exists: false }) },
            hostedAppPrefix: `intentic-sbx`,
            log: () => undefined,
        });
        await router.listen(0, `127.0.0.1`);
    });

    afterAll(async () => {
        await router.close();
    });

    // A request through the edge with its response HEADERS, which are the whole of a replay.
    const head = (host: string, path = `/`): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> =>
        new Promise((resolve, reject) => {
            const request = h1Request({ host: `127.0.0.1`, port: portOf(router.server), path, headers: { host } }, (response) => {
                response.resume();
                response.on(`end`, () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
            });
            request.on(`error`, reject);
            request.end();
        });

    test(`replays a hosted sandbox's hostname to the app named after its id, and caches the route per hostname`, async () => {
        const answer = await head(`sandbox-${HOSTED_ID}.${ZONE}`, `/events`);
        expect(answer.status).toBe(200);
        expect(answer.headers[`fly-replay`]).toBe(`app=intentic-sbx-${HOSTED_ID}`);
        // Spelled with the hostname, so the cached decision can never apply to another sandbox's name.
        expect(answer.headers[`fly-replay-cache`]).toBe(`sandbox-${HOSTED_ID}.${ZONE}/*`);
        expect(answer.headers[`fly-replay-cache-ttl-secs`]).toBe(String(REPLAY_CACHE_TTL_SECS));
    });

    // Previews, ports and the outbox ride the same replay: every name ends in the id, and the id names the app.
    test(`replays a preview hostname to the same app`, async () => {
        const answer = await head(`preview-web-${HOSTED_ID}.${ZONE}`);
        expect(answer.headers[`fly-replay`]).toBe(`app=intentic-sbx-${HOSTED_ID}`);
        expect(answer.headers[`fly-replay-cache`]).toBe(`preview-web-${HOSTED_ID}.${ZONE}/*`);
    });

    test(`prefers the app the platform names over the one the id implies`, async () => {
        const answer = await head(`sandbox-${NAMED_ID}.${ZONE}`);
        expect(answer.headers[`fly-replay`]).toBe(`app=renamed-app`);
    });

    /* FAIL OPEN. A platform that cannot say which lane an id is on leaves it unknown, and unknown replays: a
     * wrong replay costs one proxy error for a sandbox that was unreachable anyway, a wrong refusal costs a
     * working hosted sandbox its whole outage. */
    test(`replays an id whose lane the platform could not name`, async () => {
        const answer = await head(`sandbox-${UNKNOWN_ID}.${ZONE}`);
        expect(answer.headers[`fly-replay`]).toBe(`app=intentic-sbx-${UNKNOWN_ID}`);
    });

    // A sandbox on somebody's own machine is reached only through the tunnel it dials; with none held, the
    // answer stays the 502 whose body names the address — the browser's wake flow reads that, not a replay.
    test(`keeps the 502 for a tunnel-lane sandbox that is not connected`, async () => {
        const answer = await get(portOf(router.server), `sandbox-${SANDBOX_ID}.${ZONE}`);
        expect(answer.status).toBe(502);
        expect(answer.body).toContain(`sandbox-${SANDBOX_ID}`);
    });

    // Deleting the row is the revocation on this lane too: a sandbox that no longer exists is replayed nowhere.
    test(`replays nothing for a sandbox the platform says is gone`, async () => {
        const answer = await head(`sandbox-${GONE_ID}.${ZONE}`);
        expect(answer.status).toBe(502);
        expect(answer.headers[`fly-replay`]).toBeUndefined();
    });

    /* An upgrade is replayed by NOT upgrading: Fly's rule is that the app answering with the replay headers
     * must not negotiate the WebSocket itself; the target does. So the edge writes a plain head on the
     * hijacked socket, and the 101 comes from the sandbox. */
    test(`replays a websocket upgrade the same way, without upgrading it`, async () => {
        const answer = await new Promise<string>((resolve, reject) => {
            const socket = netConnect(portOf(router.server), `127.0.0.1`, () => {
                socket.write(
                    `GET /system/terminal HTTP/1.1\r\nHost: sandbox-${HOSTED_ID}.${ZONE}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
                        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
                );
            });
            const chunks: Buffer[] = [];
            socket.on(`data`, (chunk: Buffer) => chunks.push(chunk));
            socket.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)));
            socket.on(`error`, reject);
        });
        expect(answer.startsWith(`HTTP/1.1 200 OK`)).toBe(true);
        expect(answer).toContain(`fly-replay: app=intentic-sbx-${HOSTED_ID}`);
        expect(answer).not.toContain(`101`);
    });

    test(`says on /health that it replays`, async () => {
        const answer = await get(portOf(router.server), `ingress.${ZONE}`, `/health`);
        expect(JSON.parse(answer.body)).toMatchObject({ replay: true });
    });
});
