import { eventIterator, oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES, SANDBOX_ROUTES, sandboxRouteName } from "./index.js";
import { contractRoutes, routeNameForRequest, routeShapes } from "./routes.js";

const fixture = {
    vpn: {
        list: oc.route({ method: "GET", path: "/vpn" }),
        connect: oc.route({ method: "POST", path: "/vpn/{id}/connect" }),
    },
    system: {
        killTerminal: oc.route({ method: "DELETE", path: "/system/terminals/{name}" }),
    },
};

// A contract whose one route carries real schemas, so a shape can actually change between "builds".
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
        // A fingerprint is a string, and saying so is what makes the line below mean something: with `before`
        // undefined and `after` a real shape, "they differ" is true for the wrong reason.
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
        // `.default()` makes a field optional going in and required coming out: the same declaration, two
        // wire shapes. Reading both directions the same way would call them identical.
        const one = z.object({ a: z.string().default(`x`) });
        const asOutput = routeShapes(shaped(one))[`vpn.list`];
        const asInput = routeShapes({ vpn: { list: oc.route({ method: "GET", path: "/vpn" }).input(one) } })[`vpn.list`];
        expect(asOutput).toEqual(expect.any(String));
        expect(asInput).not.toBe(asOutput);
    });

    it(`treats a route declaring no schemas as a shape of its own`, () => {
        // Not a special case: "this route carries nothing" is a real shape, and a build that later gives it an
        // output has genuinely changed it. All three fixture routes declare nothing, so all three agree.
        const shapes = routeShapes(fixture);
        expect(Object.keys(shapes).toSorted()).toEqual([`system.killTerminal`, `vpn.connect`, `vpn.list`]);
        expect(new Set(Object.values(shapes)).size).toBe(1);
        expect(routeShapes(shaped(z.object({ a: z.string() })))[`vpn.list`]).not.toBe(shapes[`vpn.list`]);
    });

    it(`omits a route whose shape cannot be expressed rather than failing the walk`, () => {
        // An oRPC event iterator wraps its output in an opaque type with no schema underneath. The route keeps
        // its NAME (it is still advertised as existing) and simply carries no shape, which reads downstream as
        // "assume compatible". The two neighbours still get fingerprinted, which is the part that matters: one
        // unexpressable route must not cost the whole walk.
        const withStream = {
            vpn: {
                list: fixture.vpn.list,
                watch: oc.route({ method: "GET", path: "/vpn/watch" }).output(eventIterator(z.object({ a: z.string() }))),
            },
        };
        expect(Object.keys(routeShapes(withStream)).toSorted()).toEqual([`vpn.list`]);
        expect(
            contractRoutes(withStream)
                .map((route) => route.name)
                .toSorted(),
        ).toEqual([`vpn.list`, `vpn.watch`]);
    });
});

describe(`the real sandbox contract`, () => {
    it(`fingerprints all but the streaming routes`, () => {
        const unshaped = SANDBOX_ROUTE_NAMES.filter((name) => !(name in SANDBOX_ROUTE_SHAPES));
        // oRPC wraps an event iterator's output in an opaque type with no schema under it, so these ten
        // cannot be fingerprinted and are assumed compatible. Named rather than counted: a NEW entry here is
        // a route that quietly lost its shape check, which is worth failing a test over.
        expect(unshaped.toSorted()).toEqual([
            `agent.attach`,
            `capabilities.add`,
            // The three geo-exit moves, streaming for the same reason vpn.connect does: bringing an exit up
            // pulls a catalog, dials, and then verifies the address it landed on, which is tens of seconds on
            // the free providers and can fail with something the user has to read at each step.
            `exit.rotate`,
            `exit.start`,
            `exit.use`,
            `intentic.applyEvents`,
            `intentic.run`,
            `system.events`,
            `system.manageMachineSandbox`,
            `vpn.connect`,
        ]);
    });

    it(`fingerprints every other route exactly once`, () => {
        expect(Object.keys(SANDBOX_ROUTE_SHAPES).every((name) => SANDBOX_ROUTE_NAMES.includes(name))).toBe(true);
        expect(Object.keys(SANDBOX_ROUTE_SHAPES).length).toBe(SANDBOX_ROUTE_NAMES.length - 10);
    });

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
