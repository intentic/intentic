import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
    daemonBehind,
    daemonDrifted,
    driftedRouteReason,
    driftedRoutes,
    missingRoutes,
    resetDaemonRoutes,
    setDaemonRoutes,
    staleDaemonReason,
    supportsRoute,
} from "./useDaemonRoutes";

// A daemon level with this browser advertises the whole contract; an older one is that set minus what it
// predates. Both are supported states — the point of the store is telling them apart.
const LEVEL = [...SANDBOX_ROUTE_NAMES];
const withoutVpn = LEVEL.filter((name) => !name.startsWith(`vpn.`));

// The shapes a level daemon publishes, and the same set with named routes shaped differently — an image built
// before a field was added to them.
const SHAPES = { ...SANDBOX_ROUTE_SHAPES };
const reshaped = (...names: string[]): Record<string, string> => ({ ...SHAPES, ...Object.fromEntries(names.map((name) => [name, `different`])) });

describe(`useDaemonRoutes`, () => {
    beforeEach(() => resetDaemonRoutes());

    it(`assumes every route is supported before the daemon has said anything`, () => {
        expect(supportsRoute(`vpn.list`)).toBe(true);
        expect(daemonBehind.value).toBe(false);
        expect(missingRoutes.value).toEqual([]);
    });

    it(`assumes support from a daemon too old to advertise routes at all`, () => {
        // A daemon built before the hello frame carried `routes` sends none. Silence is not evidence of a gap,
        // so nothing may be gated on it — the pre-existing 404 behaviour is what such a daemon gets.
        setDaemonRoutes(undefined);
        expect(supportsRoute(`vpn.list`)).toBe(true);
        expect(daemonBehind.value).toBe(false);
    });

    it(`reports no gap for a daemon level with this browser`, () => {
        setDaemonRoutes(LEVEL);
        expect(missingRoutes.value).toEqual([]);
        expect(daemonBehind.value).toBe(false);
    });

    it(`names exactly what an older daemon is missing`, () => {
        setDaemonRoutes(withoutVpn);
        expect(daemonBehind.value).toBe(true);
        expect(missingRoutes.value.every((name) => name.startsWith(`vpn.`))).toBe(true);
        expect(supportsRoute(`vpn.list`)).toBe(false);
        expect(supportsRoute(`system.info`)).toBe(true);
    });

    it(`treats a daemon NEWER than this browser as level, not behind`, () => {
        // The released app plane can lag a freshly-pulled image. Routes we never ask about are not our problem.
        setDaemonRoutes([...LEVEL, `future.feature`]);
        expect(missingRoutes.value).toEqual([]);
        expect(daemonBehind.value).toBe(false);
    });

    it(`forgets the previous sandbox's surface on switch`, () => {
        setDaemonRoutes(withoutVpn);
        expect(supportsRoute(`vpn.list`)).toBe(false);
        resetDaemonRoutes();
        // Another sandbox runs another image — attributing the old one would hide a feature it really has.
        expect(supportsRoute(`vpn.list`)).toBe(true);
    });
});

describe(`driftedRoutes`, () => {
    beforeEach(() => resetDaemonRoutes());

    it(`reports no drift before the daemon has said anything`, () => {
        expect(driftedRoutes.value).toEqual([]);
        expect(daemonDrifted.value).toBe(false);
    });

    it(`reports no drift from a daemon too old to advertise shapes`, () => {
        // It sent route names but no shapes — silence is not evidence, exactly as for the names themselves.
        setDaemonRoutes(LEVEL);
        expect(driftedRoutes.value).toEqual([]);
        expect(daemonDrifted.value).toBe(false);
    });

    it(`reports no drift for a daemon level with this browser`, () => {
        setDaemonRoutes(LEVEL, SHAPES);
        expect(driftedRoutes.value).toEqual([]);
        expect(daemonDrifted.value).toBe(false);
    });

    it(`names exactly the routes whose shape moved`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`, `usage.rollup`));
        expect(driftedRoutes.value).toEqual([`settings.get`, `usage.rollup`]);
        expect(daemonDrifted.value).toBe(true);
    });

    it(`is independent of the missing-route check — a daemon can be level on names and drifted on shapes`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(daemonBehind.value).toBe(false);
        expect(daemonDrifted.value).toBe(true);
    });

    it(`compares only where BOTH sides published a fingerprint`, () => {
        // A streaming route has no expressible shape on either side, and a route the daemon simply omitted is
        // no evidence either. Neither may be reported as a disagreement.
        const partial = Object.fromEntries(Object.entries(SHAPES).filter(([name]) => !name.startsWith(`vpn.`)));
        setDaemonRoutes(LEVEL, partial);
        expect(driftedRoutes.value).toEqual([]);
    });

    it(`throws away a near-total disagreement rather than blaming every feature`, () => {
        /* Two builds on different zod versions can render the same schema differently and disagree about every
         * route at once. That is a fact about their toolchains, not about anything a user can act on. */
        const allDifferent = Object.fromEntries(Object.keys(SHAPES).map((name) => [name, `different`]));
        setDaemonRoutes(LEVEL, allDifferent);
        expect(driftedRoutes.value).toEqual([]);
        expect(daemonDrifted.value).toBe(false);
    });

    it(`forgets the previous sandbox's shapes on switch`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(daemonDrifted.value).toBe(true);
        resetDaemonRoutes();
        expect(daemonDrifted.value).toBe(false);
    });
});

describe(`driftedRouteReason`, () => {
    beforeEach(() => resetDaemonRoutes());

    it(`explains a call that reached a route the daemon shapes differently`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(driftedRouteReason(`GET`, `/settings`)).toContain(`settings.get`);
    });

    it(`stays silent for a route both sides agree on`, () => {
        setDaemonRoutes(LEVEL, SHAPES);
        expect(driftedRouteReason(`GET`, `/settings`)).toBeUndefined();
    });

    it(`stays silent for non-contract paths`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(driftedRouteReason(`GET`, `/health`)).toBeUndefined();
    });

    it(`offers reloading the page too, because drift never says which side moved`, () => {
        /* Two builds disagreeing about a payload is symmetric evidence: a page open since before the change is
         * as likely to be the stale one as the daemon. Sending someone to reload a sandbox that was already
         * current is the failure this wording exists to avoid. */
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(driftedRouteReason(`GET`, `/settings`)).toMatch(/reload this page/i);
    });
});

describe(`staleDaemonReason`, () => {
    beforeEach(() => resetDaemonRoutes());

    it(`explains a 404 on a route the daemon positively lacks`, () => {
        setDaemonRoutes(withoutVpn);
        expect(staleDaemonReason(`GET`, `/vpn`)).toContain(`vpn.list`);
    });

    it(`stays silent for a route the daemon advertises — that 404 is a real 404`, () => {
        setDaemonRoutes(LEVEL);
        expect(staleDaemonReason(`GET`, `/vpn`)).toBeUndefined();
    });

    it(`stays silent for non-contract paths like /health and file reads`, () => {
        setDaemonRoutes(withoutVpn);
        expect(staleDaemonReason(`GET`, `/health`)).toBeUndefined();
    });

    it(`stays silent while the daemon's surface is unknown`, () => {
        expect(staleDaemonReason(`GET`, `/vpn`)).toBeUndefined();
    });

    it(`names the daemon as the older side, which a missing route proves`, () => {
        // Unlike drift, this direction is known: a daemon NEWER than the app advertises extra names nobody asks
        // about, so a name the app has and the daemon lacks can only mean the daemon predates it. No hedging,
        // and no suggestion to reload a page that is not the problem.
        setDaemonRoutes(withoutVpn);
        const reason = staleDaemonReason(`GET`, `/vpn`);
        expect(reason).toMatch(/sandbox/i);
        expect(reason).not.toMatch(/reload this page/i);
    });
});
