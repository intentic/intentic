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

// Route harness's client side: a typed oRPC client over the in-process app (or one feature's routes alone), auth stubs,
// and result helpers. Both route-services.testing.ts and route-turns.testing.ts import this, arming the env hook below
// in every suite that reaches either.

// Typed client over the in-process app via the browser's own OpenAPILink, so SSE streams round-trip for real. JSON
// routes resolve to their output; thrown ORPCErrors carry `.code`.
export const clientFor = (app: Hono<AppEnv>): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(new OpenAPILink(sandboxContract, { url: "http://sandbox", fetch: async (request) => app.request(request) }));

// Without a vitest config there is no unstubEnvs, so a stubbed var would outlive the test that set it.
afterEach(() => vi.unstubAllEnvs());

// Auth stub refusing every bearer as an AUTHENTICATION failure (401), for testing a route's gate.
export const rejectAuth = async (): Promise<never> => {
    throw new Error("no bearer");
};

// Auth stub for a verified-but-unauthorized caller (403): bearer valid, identity just not allowed.
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

// Client for one feature's routes and its own deps, not the whole daemon's Services, which would break every unrelated
// suite as it grows. App middleware (auth, CORS, boot gate) is tested separately.
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
