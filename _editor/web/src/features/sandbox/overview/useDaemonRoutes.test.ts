import { resetSandboxScope } from "@intentic/extension-api";
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import {
    appBehind,
    comparedRouteCount,
    daemonBehind,
    daemonDrifted,
    driftedRouteReason,
    driftedRoutes,
    driftScope,
    missingRoutes,
    setDaemonRoutes,
    staleDaemonReason,
    supportsRoute,
    unknownDaemonRoutes,
} from "./useDaemonRoutes";
import { resetContractFreshness } from "./contractFreshness";

// This browser's full route set, and the same set with vpn routes removed (an older daemon).
const LEVEL = [...SANDBOX_ROUTE_NAMES];
const withoutVpn = LEVEL.filter((name) => !name.startsWith(`vpn.`));

// This browser's shape fingerprints, and a helper to reshape named routes (an image with a changed field).
const SHAPES = { ...SANDBOX_ROUTE_SHAPES };
const reshaped = (...names: string[]): Record<string, string> => ({ ...SHAPES, ...Object.fromEntries(names.map((name) => [name, `different`])) });

describe(`useDaemonRoutes`, () => {
    beforeEach(() => resetSandboxScope());

    it(`assumes every route is supported before the daemon has said anything`, () => {
        expect(supportsRoute(`vpn.list`)).toBe(true);
        expect(daemonBehind.value).toBe(false);
        expect(missingRoutes.value).toEqual([]);
    });

    it(`assumes support from a daemon too old to advertise routes at all`, () => {
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
        setDaemonRoutes([...LEVEL, `future.feature`]);
        expect(missingRoutes.value).toEqual([]);
        expect(daemonBehind.value).toBe(false);
    });

    it(`names the routes only the daemon has, so the older side can be the browser`, () => {
        setDaemonRoutes([...LEVEL, `future.feature`]);
        expect(unknownDaemonRoutes.value).toEqual([`future.feature`]);
        expect(appBehind.value).toBe(true);
        // Still not a warning by itself: an open tab against an updated sandbox is the ordinary case.
        expect(daemonBehind.value).toBe(false);
        expect(daemonDrifted.value).toBe(false);
    });

    it(`leans on neither side while the two are level`, () => {
        setDaemonRoutes(LEVEL, SHAPES);
        expect(unknownDaemonRoutes.value).toEqual([]);
        expect(appBehind.value).toBe(false);
    });

    it(`forgets the previous sandbox's surface on switch`, () => {
        setDaemonRoutes(withoutVpn);
        expect(supportsRoute(`vpn.list`)).toBe(false);
        resetSandboxScope();
        expect(supportsRoute(`vpn.list`)).toBe(true);
    });
});

describe(`driftedRoutes`, () => {
    beforeEach(() => resetSandboxScope());

    it(`reports no drift before the daemon has said anything`, () => {
        expect(driftedRoutes.value).toEqual([]);
        expect(daemonDrifted.value).toBe(false);
    });

    it(`reports no drift from a daemon too old to advertise shapes`, () => {
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

    it(`is independent of the missing-route check: a daemon can be level on names and drifted on shapes`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(daemonBehind.value).toBe(false);
        expect(daemonDrifted.value).toBe(true);
    });

    it(`compares only where BOTH sides published a fingerprint`, () => {
        // Filtering out vpn entries simulates a route the daemon omitted a shape for.
        const partial = Object.fromEntries(Object.entries(SHAPES).filter(([name]) => !name.startsWith(`vpn.`)));
        setDaemonRoutes(LEVEL, partial);
        expect(driftedRoutes.value).toEqual([]);
    });

    it(`calls a near-total disagreement wholesale instead of going quiet about it`, () => {
        const allDifferent = Object.fromEntries(Object.keys(SHAPES).map((name) => [name, `different`]));
        setDaemonRoutes(LEVEL, allDifferent);
        // Everything broken is the worst case there is, and it used to be the one case that warned about nothing.
        expect(daemonDrifted.value).toBe(true);
        expect(driftScope.value).toBe(`wholesale`);
        expect(driftedRoutes.value).toHaveLength(Object.keys(SHAPES).length);
    });

    it(`scopes a handful of drifted routes as partial`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`, `usage.rollup`));
        expect(driftScope.value).toBe(`partial`);
    });

    it(`scopes agreement as no drift at all`, () => {
        setDaemonRoutes(LEVEL, SHAPES);
        expect(driftScope.value).toBe(`none`);
    });

    it(`counts the routes a disagreement was actually read off, not every route there is`, () => {
        const partial = Object.fromEntries(Object.entries(SHAPES).filter(([name]) => !name.startsWith(`vpn.`)));
        setDaemonRoutes(LEVEL, partial);
        expect(comparedRouteCount.value).toBe(Object.keys(partial).length);
        expect(comparedRouteCount.value).toBeLessThan(Object.keys(SHAPES).length);
    });

    // A daemon old enough to publish few shapes is checked on few, and a couple of disagreements among them used to
    // cross the discard threshold and silence the warning entirely.
    it(`still names drift when only a few routes could be compared`, () => {
        const few: Record<string, string> = Object.fromEntries(
            Object.entries(SHAPES)
                .slice(0, 4)
                .map(([name, shape], index) => [name, index < 3 ? `different` : shape] as const),
        );
        setDaemonRoutes(LEVEL, few);
        expect(driftedRoutes.value).toHaveLength(3);
        expect(driftScope.value).toBe(`wholesale`);
    });

    it(`forgets the previous sandbox's shapes on switch`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(daemonDrifted.value).toBe(true);
        resetSandboxScope();
        expect(daemonDrifted.value).toBe(false);
    });
});

describe(`driftedRouteReason`, () => {
    beforeEach(() => {
        resetSandboxScope();
        resetContractFreshness();
    });

    it(`explains a call that reached a route the daemon shapes differently`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(driftedRouteReason(`settings.get`)).toContain(`settings.get`);
    });

    it(`stays silent for a route both sides agree on`, () => {
        setDaemonRoutes(LEVEL, SHAPES);
        expect(driftedRouteReason(`settings.get`)).toBeUndefined();
    });

    it(`offers reloading the page too, because drift never says which side moved`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        expect(driftedRouteReason(`settings.get`)).toMatch(/reload this page/i);
    });

    it(`names the stale sandbox as the cause, and rules the page reload out`, () => {
        setDaemonRoutes(LEVEL, reshaped(`settings.get`));
        resetContractFreshness([`settings.get`]);
        const reason = driftedRouteReason(`settings.get`);
        expect(reason).toMatch(/older than this checkout/i);
        expect(reason).toMatch(/dev-restart\.sh/);
        // The page is the fresher of the two here, so offering its reload sends the reader the wrong way.
        expect(reason).not.toMatch(/reload this page/i);
        // A restart is never called a reload: the reader has a browser open, and would press F5 at a stale sandbox.
        expect(reason).not.toMatch(/reload (the |it|this )?sandbox/i);
    });

    it(`blames this page when the daemon offers routes it has never heard of`, () => {
        setDaemonRoutes([...LEVEL, `future.feature`], reshaped(`settings.get`));
        expect(driftedRouteReason(`settings.get`)).toMatch(/page is running older code/i);
    });
});

describe(`staleDaemonReason`, () => {
    beforeEach(() => resetSandboxScope());

    it(`explains a 404 on a route the daemon positively lacks`, () => {
        setDaemonRoutes(withoutVpn);
        expect(staleDaemonReason(`vpn.list`)).toContain(`vpn.list`);
    });

    it(`stays silent for a route the daemon advertises: that 404 is a real 404`, () => {
        setDaemonRoutes(LEVEL);
        expect(staleDaemonReason(`vpn.list`)).toBeUndefined();
    });

    it(`stays silent while the daemon's surface is unknown`, () => {
        expect(staleDaemonReason(`vpn.list`)).toBeUndefined();
    });

    it(`names the daemon as the older side, which a missing route proves`, () => {
        setDaemonRoutes(withoutVpn);
        const reason = staleDaemonReason(`vpn.list`);
        expect(reason).toMatch(/sandbox/i);
        expect(reason).not.toMatch(/reload this page/i);
    });
});
