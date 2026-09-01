import { INGRESS_GRANT_HEADER, mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { serveIngressSession, type IngressSessionServer } from "@intentic/sandbox-contract/ingress-protocol";
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as h1Request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";
import { createIngressServer, type IngressServer } from "./server.js";

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
            revocation: { allows: () => Promise.resolve(true) },
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
