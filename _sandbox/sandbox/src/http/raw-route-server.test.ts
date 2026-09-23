import { type ContractRoute, RAW_ROUTE_LIST, SANDBOX_ROUTES, sandboxContract, sandboxRouteFor } from "@intentic/sandbox-contract";
import { StandardOpenAPIMatcher } from "@orpc/openapi/standard";
import { type AnyProcedure, implement } from "@orpc/server";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { rawRouteServer } from "./raw-route-server.js";

// The route matcher decides every gate's policy, so it must name the route the daemon actually dispatches a request
// to, at every spelling that reaches one: a request served by a route the matcher did not name would be held to the
// wrong policy. Dispatch here is the real thing: Hono over the declared raw routes, then oRPC's matcher over the rest.

// A stand-in implementation of every procedure, so oRPC's matcher can say which one a request reaches.
const implemented = implement(sandboxContract) as unknown as Record<string, Record<string, { handler: (run: () => string) => AnyProcedure }>>;
const router = Object.fromEntries(
    Object.entries(implemented).map(([group, procedures]) => [
        group,
        Object.fromEntries(Object.entries(procedures).map(([name, procedure]) => [name, procedure.handler(() => `${group}.${name}`)])),
    ]),
);

// The daemon's two dispatchers in their order, each answering with the name of the route that took the request.
const dispatcher = (): Hono<AppEnv> => {
    const matcher = new StandardOpenAPIMatcher();
    matcher.init(router);
    const app = new Hono<AppEnv>();
    const serve = rawRouteServer(app);
    for (const route of RAW_ROUTE_LIST) {
        serve(route.name, (c) => c.body(null, 204, { "x-served": route.name }));
    }
    app.all("/*", async (c) => {
        const match = await matcher.match(c.req.raw.method, `/${new URL(c.req.url).pathname.slice(1)}`);
        return c.body(null, 204, { "x-served": match?.path.join(".") ?? "" });
    });
    return app;
};

// Each route's request and the spellings a dispatcher might still serve: one to three trailing slashes, a doubled
// leading slash, empty params, and a param spelling a sibling's literal segment.
const spellingsOf = (route: ContractRoute): readonly string[] => {
    const filled = (param: (index: number) => string): string => {
        let index = 0;
        return route.path.replace(/\{[^}]+\}|\*$/gu, (token) => (token === "*" ? "a/b" : param((index += 1))));
    };
    const path = filled((index) => `p${index}`);
    const siblings = route.path.includes("{") ? ["search", "connect", "enroll", "session", "credentials", "probe", "register", "self"].map((word) => filled(() => word)) : [];
    return [path, `${path}/`, `${path}//`, `${path}///`, `/${path}`, filled(() => ""), ...siblings];
};

test("the matcher names the route the daemon dispatches to, at every spelling of every declared route", async () => {
    const app = dispatcher();
    const disagreements: { readonly request: string; readonly served: string; readonly matched: string }[] = [];
    for (const path of new Set([...RAW_ROUTE_LIST, ...SANDBOX_ROUTES].flatMap(spellingsOf))) {
        for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]) {
            const served = (await app.request(path, { method })).headers.get("x-served") ?? "";
            const matched = sandboxRouteFor(method, path)?.name ?? "";
            if (served !== matched) {
                disagreements.push({ request: `${method} ${path}`, served, matched });
            }
        }
    }
    expect(disagreements).toEqual([]);
});

// Hono also hands a `/*` route its bare prefix; the declaration covers only what follows it, so the bare path keeps the
// defaults, the session gate included.
test("a bare prefix is no part of a `/*` declaration, though Hono serves it", async () => {
    const app = dispatcher();
    for (const prefix of ["/x", "/system/runners/translator"]) {
        const served = (await app.request(prefix)).headers.get("x-served");
        expect({ prefix, served, matched: sandboxRouteFor("GET", prefix) }).toEqual({ prefix, served: `ALL ${prefix}/*`, matched: undefined });
    }
});
