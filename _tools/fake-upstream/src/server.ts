import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readBody, sendJson } from "./http.ts";

// Local stand-in for Google's two surfaces the free trial hits, serving the real wire instead of an injected fetch.
// Mirrors Google's URL shape exactly (`/v1beta/openai` base, native listing one segment up) since nativeModelsUrl
// derives it that way. Each surface refuses the other's credential, the mix-up this fake exists to catch.

// Lets a test prove a reply it saw in the browser came from here, not elsewhere.
export const DEFAULT_REPLY = `Hello from the intentic test upstream.`;
// Not a real Google id on purpose: hitting the real upstream with this should fail loudly, not quietly work.
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

// Credential each surface accepts, and the refusal for the other's. undefined answers normally; a string is the 401
// message in the real surface's shape, naming the mix-up.
const compatKey = (request: IncomingMessage): { key?: string; refusal?: string } => {
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith(`Bearer `)) {
        return { refusal: `expected an Authorization: Bearer <key> header on the OpenAI-compatible surface` };
    }
    return { key: authorization.slice(`Bearer `.length).trim() };
};

const nativeKey = (request: IncomingMessage): { key?: string; refusal?: string } => {
    // Google stops looking for an API key once handed a bearer; reproduced so the wrong dialect fails in a test.
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

            // Only surface that says what a model can do; the trial's catalog asks it before publishing anything.
            if (route === `GET /v1beta/models`) {
                const { key, refusal } = nativeKey(request);
                if (refusal !== undefined || key === undefined) {
                    return sendJson(response, 401, { error: { code: 401, message: refusal, status: `UNAUTHENTICATED` } });
                }
                if (refuseKeys.has(key)) {
                    return sendJson(response, 429, { error: { code: 429, message: `quota exceeded`, status: `RESOURCE_EXHAUSTED` } });
                }
                return sendJson(response, 200, {
                    models: models.map((id) => ({
                        name: `models/${id}`,
                        // Capability the trial actually spends; without it the platform drops the model as unchattable.
                        supportedGenerationMethods: [`generateContent`, `countTokens`],
                    })),
                });
            }

            if (route === `GET /v1beta/openai/models`) {
                const { key, refusal } = compatKey(request);
                if (refusal !== undefined || key === undefined) {
                    return sendJson(response, 401, { error: { message: refusal, type: `invalid_request_error` } });
                }
                if (refuseKeys.has(key)) {
                    return sendJson(response, 429, { error: { message: `quota exceeded`, type: `rate_limit_error` } });
                }
                // Prefixed like Google, so the platform's bareId strip actually runs instead of being bypassed.
                return sendJson(response, 200, { object: `list`, data: models.map((id) => ({ id: `models/${id}`, object: `model` })) });
            }

            if (route === `POST /v1beta/openai/chat/completions`) {
                const { key, refusal } = compatKey(request);
                if (refusal !== undefined || key === undefined) {
                    return sendJson(response, 401, { error: { message: refusal, type: `invalid_request_error` } });
                }
                const body = await readBody(request);
                if (refuseKeys.has(key)) {
                    // Recorded even when refused: a test asserting the pool walked every key needs to see them.
                    received.push(body);
                    return sendJson(response, 429, { error: { message: `quota exceeded`, type: `rate_limit_error` } });
                }
                received.push(body);
                const asked = JSON.parse(body === `` ? `{}` : body) as { model?: unknown; stream?: unknown };
                const model = typeof asked.model === `string` ? asked.model : (models[0] ?? `fake-flash-latest`);
                if (asked.stream !== true) {
                    return sendJson(response, 200, {
                        id: `chatcmpl-fake`,
                        object: `chat.completion`,
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{ index: 0, message: { role: `assistant`, content: reply }, finish_reason: `stop` }],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    });
                }
                // SSE because the trial route pipes the body straight through to an agent reading frames; JSON-only
                // here would leave the whole streaming path uncovered.
                response.writeHead(200, { "content-type": `text/event-stream`, "cache-control": `no-cache`, connection: `keep-alive` });
                response.write(chunk(model, { role: `assistant`, content: `` }, null));
                response.write(chunk(model, { content: reply }, null));
                response.write(chunk(model, {}, `stop`));
                response.write(`data: [DONE]\n\n`);
                return response.end();
            }

            // Unauthenticated on purpose: a readiness probe needing a credential tests the credential, not the server.
            if (route === `GET /health`) {
                return sendJson(response, 200, { ok: true, models });
            }

            return sendJson(response, 404, { error: { message: `no such route: ${route}`, type: `invalid_request_error` } });
        })().catch(() => {
            if (!response.headersSent) {
                sendJson(response, 500, { error: { message: `fake upstream failed`, type: `server_error` } });
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
