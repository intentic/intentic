import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/* A STAND-IN FOR THE MODEL THE FREE TRIAL SPENDS. Google's two surfaces, served locally, deterministically.
 *
 * The platform's trial is the one place this product sits on the command path, and until now nothing exercised
 * it end to end: `trial.routes.ts` was covered by unit tests with an injected `fetch`, which proves the routing
 * and proves nothing about the wire. This serves the wire. `TRIAL_BASE_URL` is already config and already
 * documented as "any OpenAI-compatible upstream", so pointing the platform here needs NO product change.
 *
 * It mirrors Google's URL SHAPE rather than inventing one, because the shape is relied on: `nativeModelsUrl`
 * derives the native listing by stripping a trailing `/openai` from the configured base, so a stand-in served
 * at some flat `/v1` would silently take the "upstream will not say what its models can do" branch and the
 * discovery path this exists to cover would never run. Base is `/v1beta/openai`; the native listing sits one
 * segment up at `/v1beta/models`, exactly as it does at Google.
 *
 * IT ENFORCES THE TWO DIALECTS, and that is the point of a fake that could otherwise have answered everything.
 * The compatibility shim reads `Authorization: Bearer`; Google's own surface beside it refuses a bearer outright
 * and wants `x-goog-api-key` (trial-pool.ts carries the account of the 401 that taught us). A stand-in that
 * accepted either would go green on precisely the mix-up that broke the catalog in the field, so each surface
 * here refuses the other's credential the way the real one does.
 */

// What a caller reads back, so a test can assert the reply it saw in a browser came from here and nowhere else.
export const DEFAULT_REPLY = `Hello from the intentic test upstream.`;
// Deliberately not a real Google id: anything reaching the real upstream with these is a misconfiguration we
// want to see fail, not one that quietly works.
export const DEFAULT_MODELS: readonly string[] = [`fake-flash-latest`];

export interface FakeUpstreamOptions {
    /** 0 (the default) takes any free port and reports it back, the only safe choice when tests run in parallel. */
    readonly port?: number;
    readonly models?: readonly string[];
    readonly reply?: string;
    /** Keys that always answer 429, so a test can drive the platform's pool walk without a real quota. */
    readonly refuseKeys?: readonly string[];
}

export interface FakeUpstream {
    /** What to set TRIAL_BASE_URL to. Ends in `/openai` so the platform derives the native listing beside it. */
    readonly baseUrl: string;
    readonly port: number;
    /** Every chat body this upstream was sent, in order, what a test asserts the prompt actually reached. */
    readonly received: readonly string[];
    close(): Promise<void>;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": `application/json`, "content-length": Buffer.byteLength(text) });
    response.end(text);
};

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString(`utf8`);
};

/* The credential each surface accepts, and the refusal each gives the OTHER one's.
 *
 * `undefined` means "answer normally". A string is the refusal message, returned as 401 in the same shape the
 * real surface uses, so a platform-side mix-up fails here with the sentence that names it. */
const compatKey = (request: IncomingMessage): { key?: string; refusal?: string } => {
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith(`Bearer `)) {
        return { refusal: `expected an Authorization: Bearer <key> header on the OpenAI-compatible surface` };
    }
    return { key: authorization.slice(`Bearer `.length).trim() };
};

const nativeKey = (request: IncomingMessage): { key?: string; refusal?: string } => {
    // Google's own answer to a bearer, and the reason `UpstreamAuth` exists: handed one it stops looking for an
    // API key at all. Reproduced here so the platform sending the wrong dialect fails in a test, not in a picker.
    if (request.headers.authorization !== undefined) {
        return { refusal: `Expected OAuth 2 access token, the native surface takes x-goog-api-key, not a bearer` };
    }
    const key = request.headers[`x-goog-api-key`];
    if (typeof key !== `string` || key === ``) {
        return { refusal: `expected an x-goog-api-key header on the native surface` };
    }
    return { key };
};

const chunk = (model: string, delta: object, finish: string | null): string =>
    `data: ${JSON.stringify({
        id: `chatcmpl-fake`,
        object: `chat.completion.chunk`,
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

export const startFakeUpstream = async (options: FakeUpstreamOptions = {}): Promise<FakeUpstream> => {
    const models = options.models ?? DEFAULT_MODELS;
    const reply = options.reply ?? DEFAULT_REPLY;
    const refuseKeys = new Set(options.refuseKeys ?? []);
    const received: string[] = [];

    const server: Server = createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? `/`, `http://localhost`);
            const route = `${request.method ?? `GET`} ${url.pathname}`;

            // Google's native listing: the ONLY surface that says what a model can do, which is why the trial's
            // catalog asks it before publishing anything.
            if (route === `GET /v1beta/models`) {
                const { key, refusal } = nativeKey(request);
                if (refusal !== undefined || key === undefined) {
                    return json(response, 401, { error: { code: 401, message: refusal, status: `UNAUTHENTICATED` } });
                }
                if (refuseKeys.has(key)) {
                    return json(response, 429, { error: { code: 429, message: `quota exceeded`, status: `RESOURCE_EXHAUSTED` } });
                }
                return json(response, 200, {
                    models: models.map((id) => ({
                        name: `models/${id}`,
                        // The capability the trial actually spends. Without it the platform reads the model as
                        // one that cannot be chatted with and drops it, the filter this fake exists to feed.
                        supportedGenerationMethods: [`generateContent`, `countTokens`],
                    })),
                });
            }

            if (route === `GET /v1beta/openai/models`) {
                const { key, refusal } = compatKey(request);
                if (refusal !== undefined || key === undefined) {
                    return json(response, 401, { error: { message: refusal, type: `invalid_request_error` } });
                }
                if (refuseKeys.has(key)) {
                    return json(response, 429, { error: { message: `quota exceeded`, type: `rate_limit_error` } });
                }
                // Prefixed the way Google prefixes them, so the platform's `bareId` strip is exercised rather
                // than bypassed by a fake that helpfully answered in the shape the platform wanted.
                return json(response, 200, { object: `list`, data: models.map((id) => ({ id: `models/${id}`, object: `model` })) });
            }

            if (route === `POST /v1beta/openai/chat/completions`) {
                const { key, refusal } = compatKey(request);
                if (refusal !== undefined || key === undefined) {
                    return json(response, 401, { error: { message: refusal, type: `invalid_request_error` } });
                }
                const body = await readBody(request);
                if (refuseKeys.has(key)) {
                    // Recorded even when refused: a test asserting the pool walked every key needs to see them.
                    received.push(body);
                    return json(response, 429, { error: { message: `quota exceeded`, type: `rate_limit_error` } });
                }
                received.push(body);
                const asked = JSON.parse(body === `` ? `{}` : body) as { model?: unknown; stream?: unknown };
                const model = typeof asked.model === `string` ? asked.model : (models[0] ?? `fake-flash-latest`);
                if (asked.stream !== true) {
                    return json(response, 200, {
                        id: `chatcmpl-fake`,
                        object: `chat.completion`,
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{ index: 0, message: { role: `assistant`, content: reply }, finish_reason: `stop` }],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    });
                }
                /* Streamed as SSE, because the trial route pipes upstream's body straight through and the agent
                 * on the far end reads frames. A fake that only ever answered plain JSON would leave the whole
                 * streaming path, the one a user actually watches, uncovered. */
                response.writeHead(200, { "content-type": `text/event-stream`, "cache-control": `no-cache`, connection: `keep-alive` });
                response.write(chunk(model, { role: `assistant`, content: `` }, null));
                response.write(chunk(model, { content: reply }, null));
                response.write(chunk(model, {}, `stop`));
                response.write(`data: [DONE]\n\n`);
                return response.end();
            }

            // Liveness, for whatever is waiting on this container. Unauthenticated on purpose: a readiness probe
            // that needs a credential is a probe that reports the credential's health, not the server's.
            if (route === `GET /health`) {
                return json(response, 200, { ok: true, models });
            }

            return json(response, 404, { error: { message: `no such route: ${route}`, type: `invalid_request_error` } });
        })().catch(() => {
            if (!response.headersSent) {
                json(response, 500, { error: { message: `fake upstream failed`, type: `server_error` } });
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
        baseUrl: `http://127.0.0.1:${port}/v1beta/openai`,
        port,
        received,
        close: () =>
            new Promise<void>((resolveClose) => {
                server.closeAllConnections();
                server.close(() => resolveClose());
            }),
    };
};
