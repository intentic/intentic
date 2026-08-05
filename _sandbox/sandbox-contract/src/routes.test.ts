import { oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTES, sandboxRouteName } from "./index.js";
import { contractRoutes, routeNameForRequest } from "./routes.js";

const fixture = {
    vpn: {
        list: oc.route({ method: "GET", path: "/vpn" }),
        connect: oc.route({ method: "POST", path: "/vpn/{id}/connect" }),
    },
    system: {
        killTerminal: oc.route({ method: "DELETE", path: "/system/terminals/{name}" }),
    },
};

describe(`contractRoutes`, () => {
    it(`names every procedure <group>.<route>, sorted`, () => {
        expect(contractRoutes(fixture).map((route) => route.name)).toEqual([`system.killTerminal`, `vpn.connect`, `vpn.list`]);
    });

    it(`carries the wire method and path template`, () => {
        expect(contractRoutes(fixture).find((route) => route.name === `vpn.connect`)).toEqual({
            name: `vpn.connect`,
            method: `POST`,
            path: `/vpn/{id}/connect`,
        });
    });

    it(`ignores non-procedure members rather than inventing routes for them`, () => {
        expect(contractRoutes({ vpn: { list: fixture.vpn.list, NOT_A_ROUTE: { hello: true } } }).map((r) => r.name)).toEqual([`vpn.list`]);
    });
});

describe(`routeNameForRequest`, () => {
    const routes = contractRoutes(fixture);

    it(`matches a literal path`, () => {
        expect(routeNameForRequest(routes, `GET`, `/vpn`)).toBe(`vpn.list`);
    });

    it(`matches a templated segment`, () => {
        expect(routeNameForRequest(routes, `POST`, `/vpn/corp-gw/connect`)).toBe(`vpn.connect`);
        expect(routeNameForRequest(routes, `DELETE`, `/system/terminals/web-1`)).toBe(`system.killTerminal`);
    });

    it(`strips the query string before matching`, () => {
        expect(routeNameForRequest(routes, `GET`, `/vpn?refresh=1`)).toBe(`vpn.list`);
    });

    it(`is method-sensitive`, () => {
        expect(routeNameForRequest(routes, `POST`, `/vpn`)).toBeUndefined();
    });

    it(`never matches a longer or shorter path than the template`, () => {
        expect(routeNameForRequest(routes, `POST`, `/vpn/corp-gw/connect/extra`)).toBeUndefined();
        expect(routeNameForRequest(routes, `POST`, `/vpn/connect`)).toBeUndefined();
    });

    it(`does not let an empty segment stand in for a param`, () => {
        expect(routeNameForRequest(routes, `DELETE`, `/system/terminals/`)).toBeUndefined();
    });

    it(`returns undefined for the daemon's hand-written non-contract routes`, () => {
        expect(routeNameForRequest(routes, `GET`, `/health`)).toBeUndefined();
    });
});

describe(`the real sandbox contract`, () => {
    it(`derives a route table with no duplicate names`, () => {
        expect(SANDBOX_ROUTE_NAMES.length).toBe(SANDBOX_ROUTES.length);
        expect(new Set(SANDBOX_ROUTE_NAMES).size).toBe(SANDBOX_ROUTE_NAMES.length);
    });

    it(`covers every oc.route in the contract`, () => {
        // Guards the walk against a future contract nesting deeper than group → procedure, which would
        // silently advertise fewer routes than the daemon serves.
        expect(SANDBOX_ROUTES.length).toBeGreaterThan(100);
    });

    it(`resolves a known concrete request back to its contract name`, () => {
        expect(sandboxRouteName(`GET`, `/vpn`)).toBe(`vpn.list`);
    });
});
