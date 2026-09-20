import { eventIterator, oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES, SANDBOX_ROUTES, sandboxRouteName } from "../index.js";
import { contractRoutes, routeNameForRequest, routeShapes, streamOf } from "./routes.js";

const fixture = {
    vpn: {
        list: oc.route({ method: "GET", path: "/vpn" }),
        connect: oc.route({ method: "POST", path: "/vpn/{id}/connect" }),
    },
    system: {
        killTerminal: oc.route({ method: "DELETE", path: "/system/terminals/{name}" }),
    },
};

// A contract whose one route carries real schemas, so its shape can change between builds.
const shaped = (output: z.ZodType) => ({ vpn: { list: oc.route({ method: "GET", path: "/vpn" }).output(output) } });

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

describe(`routeShapes`, () => {
    it(`gives the same fingerprint for the same shape, twice`, () => {
        expect(routeShapes(shaped(z.object({ a: z.string() })))).toEqual(routeShapes(shaped(z.object({ a: z.string() }))));
    });

    it(`changes the fingerprint when a field is added`, () => {
        const before = routeShapes(shaped(z.object({ a: z.string() })))[`vpn.list`];
        const after = routeShapes(shaped(z.object({ a: z.string(), b: z.number() })))[`vpn.list`];
        expect(before).toEqual(expect.any(String));
        expect(after).not.toBe(before);
    });

    it(`changes the fingerprint when a field's type changes`, () => {
        const before = routeShapes(shaped(z.object({ a: z.string() })))[`vpn.list`];
        const after = routeShapes(shaped(z.object({ a: z.number() })))[`vpn.list`];
        expect(after).not.toBe(before);
    });

    it(`is blind to the order fields are declared in: a reordered object is not a wire change`, () => {
        const one = routeShapes(shaped(z.object({ a: z.string(), b: z.number() })))[`vpn.list`];
        const other = routeShapes(shaped(z.object({ b: z.number(), a: z.string() })))[`vpn.list`];
        expect(other).toBe(one);
    });

    it(`reads a defaulted field differently on the way in than on the way out`, () => {
        // `.default()` makes a field optional on input, required on output: same declaration, two shapes.
        const one = z.object({ a: z.string().default(`x`) });
        const asOutput = routeShapes(shaped(one))[`vpn.list`];
        const asInput = routeShapes({ vpn: { list: oc.route({ method: "GET", path: "/vpn" }).input(one) } })[`vpn.list`];
        expect(asOutput).toEqual(expect.any(String));
        expect(asInput).not.toBe(asOutput);
    });

    it(`treats a route declaring no schemas as a shape of its own`, () => {
        // All three fixture routes declare nothing, so all three share one shape; giving one an output later is a real
        // change.
        const shapes = routeShapes(fixture);
        expect(Object.keys(shapes).toSorted()).toEqual([`system.killTerminal`, `vpn.connect`, `vpn.list`]);
        expect(new Set(Object.values(shapes)).size).toBe(1);
        expect(routeShapes(shaped(z.object({ a: z.string() })))[`vpn.list`]).not.toBe(shapes[`vpn.list`]);
    });

    it(`fingerprints a stream through the frames it declares`, () => {
        const withStream = {
            vpn: {
                list: fixture.vpn.list,
                watch: oc.route({ method: "GET", path: "/vpn/watch" }).output(streamOf(z.object({ a: z.string() }))),
            },
        };
        expect(Object.keys(routeShapes(withStream)).toSorted()).toEqual([`vpn.list`, `vpn.watch`]);
        // A changed frame is a changed route, which is the whole point of reaching past the iterator.
        const reframed = { vpn: { watch: oc.route({ method: "GET", path: "/vpn/watch" }).output(streamOf(z.object({ a: z.number() }))) } };
        expect(routeShapes(reframed)[`vpn.watch`]).not.toBe(routeShapes(withStream)[`vpn.watch`]);
    });

    it(`tells a stream of X apart from a route that answers X`, () => {
        const frame = z.object({ a: z.string() });
        const streamed = { vpn: { watch: oc.route({ method: "GET", path: "/vpn/watch" }).output(streamOf(frame)) } };
        const answered = { vpn: { watch: oc.route({ method: "GET", path: "/vpn/watch" }).output(frame) } };
        expect(routeShapes(streamed)[`vpn.watch`]).not.toBe(routeShapes(answered)[`vpn.watch`]);
    });

    it(`omits a route whose shape cannot be expressed rather than failing the walk`, () => {
        // oRPC's own eventIterator hides its frames, which is why contracts declare streams with streamOf; one that
        // slipped through keeps its name and loses only its shape, instead of breaking the walk for every other route.
        const withRawIterator = {
            vpn: {
                list: fixture.vpn.list,
                watch: oc.route({ method: "GET", path: "/vpn/watch" }).output(eventIterator(z.object({ a: z.string() }))),
            },
        };
        expect(Object.keys(routeShapes(withRawIterator)).toSorted()).toEqual([`vpn.list`]);
        expect(
            contractRoutes(withRawIterator)
                .map((route) => route.name)
                .toSorted(),
        ).toEqual([`vpn.list`, `vpn.watch`]);
    });
});

describe(`the real sandbox contract`, () => {
    it(`fingerprints every route, streams included`, () => {
        // Nothing may opt out: a route with no fingerprint is a route the browser can never tell has drifted, and the
        // streaming ones (system.events, agent.attach, the exit dials) carry the frames a stale daemon breaks first.
        expect(SANDBOX_ROUTE_NAMES.filter((name) => !(name in SANDBOX_ROUTE_SHAPES))).toEqual([]);
    });

    it(`fingerprints the streaming routes eventIterator used to hide`, () => {
        expect(
            [
                `agent.attach`,
                `capabilities.add`,
                `exit.rotate`,
                `exit.start`,
                `exit.use`,
                `intentic.applyEvents`,
                `intentic.run`,
                `netdisk.mount`,
                `system.events`,
                `system.manageDeviceSandbox`,
                `system.runDeviceAgentFlow`,
                `vpn.connect`,
            ].filter((name) => name in SANDBOX_ROUTE_SHAPES).toSorted(),
        ).toEqual([
            `agent.attach`,
            `capabilities.add`,
            `exit.rotate`,
            `exit.start`,
            `exit.use`,
            `intentic.applyEvents`,
            `intentic.run`,
            `netdisk.mount`,
            `system.events`,
            `system.manageDeviceSandbox`,
            `system.runDeviceAgentFlow`,
            `vpn.connect`,
        ]);
    });

    it(`fingerprints every route exactly once`, () => {
        expect(Object.keys(SANDBOX_ROUTE_SHAPES).every((name) => SANDBOX_ROUTE_NAMES.includes(name))).toBe(true);
        expect(Object.keys(SANDBOX_ROUTE_SHAPES).length).toBe(SANDBOX_ROUTE_NAMES.length);
    });

    it(`derives a route table with no duplicate names`, () => {
        expect(SANDBOX_ROUTE_NAMES.length).toBe(SANDBOX_ROUTES.length);
        expect(new Set(SANDBOX_ROUTE_NAMES).size).toBe(SANDBOX_ROUTE_NAMES.length);
    });

    it(`covers every oc.route in the contract`, () => {
        // Guards against a contract nesting deeper than group → procedure, which would silently under-report routes.
        expect(SANDBOX_ROUTES.length).toBeGreaterThan(100);
    });

    // The fleet payload decides whether every "do it out there" button is drawn at all, so a daemon shaping it
    // differently has to read as drift rather than as a machine that runs nothing.
    it(`fingerprints the fleet view the device buttons are gated on`, () => {
        expect(sandboxRouteName(`GET`, `/system/devices`)).toBe(`system.devices`);
        expect(SANDBOX_ROUTE_SHAPES[`system.devices`]).toEqual(expect.any(String));
    });

    it(`resolves a known concrete request back to its contract name`, () => {
        expect(sandboxRouteName(`GET`, `/vpn`)).toBe(`vpn.list`);
    });
});
