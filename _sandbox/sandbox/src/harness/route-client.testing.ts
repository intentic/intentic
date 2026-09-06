import { sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { AnyRouter } from "@orpc/server";
import type { Hono } from "hono";
import { afterEach, vi } from "vitest";
import { ForbiddenError } from "../auth/auth.js";
import type { AppEnv, OrpcContext } from "../app-env.js";

/* The route harness's client side: the typed oRPC client over an in-process app (or over one feature's routes
 * alone), the auth stubs a gate test hands `services`, and the helpers that read what came back.
 * route-services.testing.ts and route-turns.testing.ts both import from here, so the env hook below is armed in
 * every suite that reaches either. Not part of the build (tsconfig excludes `*.testing.ts`), type-checked with
 * the tests (tsconfig.test.json). */

// A typed oRPC client over the in-process Hono app, the same OpenAPILink the browser uses, so streams round-
// trip through the real SSE encode/decode. JSON routes resolve to their output; thrown ORPCErrors carry `.code`.
export const clientFor = (app: Hono<AppEnv>): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(new OpenAPILink(sandboxContract, { url: "http://sandbox", fetch: async (request) => app.request(request) }));

// Without a vitest config there is no unstubEnvs, so a stubbed var would outlive the test that set it.
afterEach(() => vi.unstubAllEnvs());

// An auth stub that refuses every bearer as an AUTHENTICATION failure (→ 401), proves a route's gate (or its
// exemption from the bearer middleware).
export const rejectAuth = async (): Promise<never> => {
    throw new Error("no bearer");
};

// An auth stub for a verified-but-unauthorized caller (→ 403): the bearer is valid, the identity just isn't
// allowed (wrong Google account / member hitting an owner-only route).
export const rejectForbidden = async (): Promise<never> => {
    throw new ForbiddenError("not the sandbox owner");
};

// A JSON POST against the in-process app, for the plain (non-oRPC) routes.
export const postJson = async (app: Hono<AppEnv>, path: string, body?: unknown): Promise<Response> =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const errorCode = async (run: Promise<unknown>): Promise<string | undefined> => {
    try {
        await run;
    } catch (error) {
        return (error as { code?: string }).code;
    }
    return undefined;
};

export const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
    const events: T[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
};

/* A client for ONE feature's routes, over that feature's own deps.
 *
 * `clientFor(createApp(services(...)))` builds the whole daemon to ask a question about one route: it needs a
 * hundred-and-thirty-member Services, and every service the daemon grows breaks a suite
 * that never mentions it. A route factory that declares what it reads (composition.ts, "WHAT A MODULE SHOULD
 * TAKE OF IT") can be stood up on exactly that, a plain object literal the compiler checks in full, with no
 * stand-in and nothing unstubbed to reach past.
 *
 * The app-level middleware is deliberately absent: auth, CORS and the boot gate belong to the app and are
 * tested there (app.integration.test.ts). What is left here is the route and its own deps. */
export const routesClient = <TContract extends AnyContractRouter>(contract: TContract, router: AnyRouter): ContractRouterClient<TContract> => {
    const handler = new OpenAPIHandler(router);
    return createORPCClient(
        new OpenAPILink(contract, {
            url: "http://sandbox",
            fetch: async (request) => {
                const url = new URL(request.url);
                const context: OrpcContext = { headers: request.headers, method: request.method, url: url.pathname + url.search };
                const { response } = await handler.handle(request, { context });
                return response ?? new Response("no matching procedure", { status: 404 });
            },
        }),
    );
};
