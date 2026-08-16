import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

/* A STAND-IN FOR THE TUNNEL HUB — the three calls the platform makes to zrok, and nothing else.
 *
 * Reachability is the one thing standing between a hermetic test and the whole install path. Every installer
 * lane begins the same way: the wizard asks the platform for a setup code, and the platform refuses to mint one
 * without a tunnel fabric to put the sandbox behind. So a test with no hub cannot reach the second step of any
 * of the four onboarding paths, and this exists to answer that question rather than to be a tunnel.
 *
 * IT DOES NOT TUNNEL ANYTHING, and nothing downstream needs it to. The sandbox's own `zrok2 enable` against
 * this will fail, and the daemon's entrypoint treats that as non-fatal on purpose (docker-entrypoint.sh) — it
 * logs and serves anyway. The browser then reaches the box the way a browser on the same machine always
 * prefers to: the loopback port the container publishes, which is a hop away and needs no fabric at all.
 *
 * Pointing the platform here needs NO product change: `ZROK_API_ENDPOINT` and `ZROK_ADMIN_TOKEN` are already
 * config, and the token is also the switch that decides whether this platform mints addresses at all.
 */

// The hub's own media type, not `application/json` — zrok's v2 API declares it on every operation, and the
// platform's client sends it. Answering in it is what keeps this a faithful stand-in rather than a lenient one.
const MEDIA_TYPE = `application/zrok.v1+json`;

export interface FakeZrokOptions {
    readonly port?: number;
    /** The admin token this hub accepts. Anything else is refused 401, exactly as the real one refuses it. */
    readonly adminToken?: string;
}

export interface FakeZrok {
    readonly endpoint: string;
    readonly port: number;
    /** Accounts minted, by email — what a test asserts the platform actually provisioned. */
    readonly accounts: ReadonlyMap<string, string>;
    close(): Promise<void>;
}

export const DEFAULT_ADMIN_TOKEN = `onboarding-zrok-admin`;
export const NAMESPACE_TOKEN = `onboarding-public-namespace`;

const send = (response: ServerResponse, status: number, body: unknown): void => {
    const text = body === undefined ? `` : JSON.stringify(body);
    response.writeHead(status, { "content-type": MEDIA_TYPE, "content-length": Buffer.byteLength(text) });
    response.end(text);
};

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString(`utf8`);
    return text === `` ? {} : (JSON.parse(text) as Record<string, unknown>);
};

export const startFakeZrok = async (options: FakeZrokOptions = {}): Promise<FakeZrok> => {
    const adminToken = options.adminToken ?? DEFAULT_ADMIN_TOKEN;
    const accounts = new Map<string, string>();

    const server: Server = createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? `/`, `http://localhost`);
            const route = `${request.method ?? `GET`} ${url.pathname}`;

            // Unauthenticated, so whatever is waiting on this container can ask without holding a credential.
            if (route === `GET /health`) {
                return send(response, 200, { ok: true, accounts: accounts.size });
            }

            /* The admin token, refused the way the hub refuses it. Worth reproducing rather than waving
             * through: 401 is the one status the platform's client turns into a sentence naming the two
             * settings behind it, and a stand-in that accepted anything would never let that path run. */
            if (request.headers[`x-token`] !== adminToken) {
                return send(response, 401, { message: `unauthorized` });
            }

            // The wildcard frontend's namespace. The platform resolves it once and hands the token into the box.
            if (route === `GET /api/v2/namespaces`) {
                return send(response, 200, [{ namespaceToken: NAMESPACE_TOKEN, name: `public`, open: true }]);
            }

            if (route === `POST /api/v2/account`) {
                const body = await readBody(request);
                const email = typeof body[`email`] === `string` ? body[`email`] : ``;
                if (email === ``) {
                    return send(response, 400, { message: `email is required` });
                }
                /* A DUPLICATE answers 500, which is not sloppiness — it is what the real hub does, and the
                 * platform's one retry (delete, then create again) exists solely because of it. A stand-in
                 * that happily re-created would leave that recovery path unrun. */
                if (accounts.has(email)) {
                    return send(response, 500, { message: `account already exists` });
                }
                const accountToken = randomBytes(12).toString(`base64url`);
                accounts.set(email, accountToken);
                return send(response, 201, { accountToken });
            }

            if (route === `DELETE /api/v2/account`) {
                const body = await readBody(request);
                const email = typeof body[`email`] === `string` ? body[`email`] : ``;
                // 404 for an account already gone — the platform reads that as success, so removal is idempotent.
                return accounts.delete(email) ? send(response, 200, undefined) : send(response, 404, { message: `no such account` });
            }

            return send(response, 404, { message: `no such route: ${route}` });
        })().catch(() => {
            if (!response.headersSent) {
                send(response, 500, { message: `fake zrok failed` });
            } else {
                response.end();
            }
        });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
        server.once(`error`, rejectListen);
        server.listen(options.port ?? 0, `0.0.0.0`, resolveListen);
    });
    const port = (server.address() as AddressInfo).port;

    return {
        endpoint: `http://127.0.0.1:${port}`,
        port,
        accounts,
        close: () =>
            new Promise<void>((resolveClose) => {
                server.closeAllConnections();
                server.close(() => resolveClose());
            }),
    };
};
