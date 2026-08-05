import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { daemonBehind, missingRoutes, resetDaemonRoutes, setDaemonRoutes, staleDaemonReason, supportsRoute } from "./useDaemonRoutes";

// A daemon level with this browser advertises the whole contract; an older one is that set minus what it
// predates. Both are supported states — the point of the store is telling them apart.
const LEVEL = [...SANDBOX_ROUTE_NAMES];
const withoutVpn = LEVEL.filter((name) => !name.startsWith(`vpn.`));

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
});
