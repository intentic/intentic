import { resetSandboxScope } from "@intentic/extension-api";
import { stubEnv, unstubAllEnvs } from "@intentic/testing/bun";
import { RAW_ROUTE_NAMES, rawRouteFingerprints, SANDBOX_ROUTE_NAMES, sandboxRouteFingerprints } from "@intentic/sandbox-contract";
import {
    appBehind,
    comparedRouteCount,
    daemonBehind,
    daemonDrifted,
    driftedRouteReason,
    driftedRoutes,
    driftScope,
    folderSurface,
    missingRoutes,
    setDaemonRoutes,
    staleDaemonReason,
    supportsRoute,
    unknownDaemonRoutes,
} from "./useDaemonRoutes";
import { resetContractFreshness } from "./contractFreshness";
import { loadContract } from "./daemon/contract";

// This browser's full route set, and the same set with vpn routes removed (an older daemon).
const LEVEL = [...SANDBOX_ROUTE_NAMES];
const withoutVpn = LEVEL.filter((name) => !name.startsWith(`vpn.`));

// This browser's shape fingerprints, and a helper to reshape named routes (an image with a changed field).
const SHAPES = { ...sandboxRouteFingerprints() };
const reshaped = (...names: string[]): Record<string, string> => ({ ...SHAPES, ...Object.fromEntries(names.map((name) => [name, `different`])) });

// The contract loads beside the start (daemon/contract.ts). Until it lands this build has no route names to compare, which must
// read as no evidence in either direction, never as one side being behind; once it lands, the same hello reads as always.
describe(`before the contract has landed`, () => {
    beforeEach(() => resetSandboxScope());

    it(`reads no drift either way, then reads the hello once the contract lands`, async () => {
        setDaemonRoutes([...withoutVpn, `made.up`]);
        expect(missingRoutes.value).toEqual([]);
        expect(unknownDaemonRoutes.value).toEqual([]);
        expect(appBehind.value).toBe(false);
        expect(daemonBehind.value).toBe(false);

        await loadContract();
        expect(unknownDaemonRoutes.value).toEqual([`made.up`]);
        expect(daemonBehind.value).toBe(true);
    });
});

describe(`useDaemonRoutes`, () => {
    beforeAll(async () => {
        await loadContract();
    });
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

    // What a person on the shipped app reads: the part of the app in plain words, never the dotted route id, and the
    // update as the way out. A dev build adds the id (above), which is what a fix is written against.
    describe(`in a shipped build`, () => {
        beforeEach(() => stubEnv(`DEV`, ``));
        afterEach(() => unstubAllEnvs());

        it(`names the part of the app rather than the route`, () => {
            setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `org.policy`));
            const reason = staleDaemonReason(`org.policy`);
            expect(reason).toBe(`This sandbox is too old for this part of the app (Organisation). Update the sandbox to a newer image to use this feature.`);
            expect(reason).not.toContain(`org.policy`);
        });

        it(`names no part at all for a route of no named area, and still no id`, () => {
            setDaemonRoutes(LEVEL.filter((name) => name !== `vpn.list`));
            expect(staleDaemonReason(`vpn.list`)).toContain(`(VPN)`);
            setDaemonRoutes(undefined, undefined, undefined, { rawRoutes: RAW_ROUTE_NAMES.filter((name) => name !== `GET /x/unnamed`) });
            expect(staleDaemonReason(`GET /x/unnamed`)).toBe(`This sandbox is too old for this part of the app. Update the sandbox to a newer image to use this feature.`);
        });

        it(`says the same of a drifted route`, () => {
            setDaemonRoutes(LEVEL, { ...sandboxRouteFingerprints(), "settings.get": `different` });
            const reason = driftedRouteReason(`settings.get`);
            expect(reason).toMatch(/^This sandbox answers this part of the app \(Sandbox settings\) with different fields/);
            expect(reason).not.toContain(`settings.get`);
        });
    });
});

// The daemon's hand-written routes (`POST /workspace/upload-diff`), which used to be advertised nowhere: a call onto
// one an older daemon predates could only come back as a bare 404, and a feature gated on one was hidden against every
// daemon there is, since none of them named it.
describe(`the hand-written routes`, () => {
    const RAW = [...RAW_ROUTE_NAMES];
    const RAW_PRINTS = { ...rawRouteFingerprints() };
    const LINKS = `GET /system/links`;
    const withoutLinks = RAW.filter((name) => name !== LINKS);
    const sandbox = (raw: readonly string[] | undefined, prints?: Record<string, string>): void =>
        setDaemonRoutes(LEVEL, SHAPES, undefined, { rawRoutes: raw === undefined ? undefined : [...raw], rawFingerprints: prints });

    beforeEach(() => resetSandboxScope());

    it(`assumes a daemon from before the field answers them, as it does for an unknown procedure surface`, () => {
        sandbox(undefined);
        expect([supportsRoute(LINKS), daemonBehind.value, missingRoutes.value]).toEqual([true, false, []]);
    });

    it(`gates on them once a daemon says which it serves`, () => {
        sandbox(RAW);
        expect(supportsRoute(LINKS)).toBe(true);
        sandbox(withoutLinks);
        expect(supportsRoute(LINKS)).toBe(false);
    });

    // The whole point: the gap reaches the reader as a gap, in the same words a missing procedure gets, rather than as
    // the 404 the call would otherwise come back as.
    it(`names the one a daemon predates, and says to update the sandbox`, () => {
        sandbox(withoutLinks);
        expect(missingRoutes.value).toEqual([LINKS]);
        expect(daemonBehind.value).toBe(true);
        expect(staleDaemonReason(LINKS)).toMatch(/^This sandbox is too old for this part of the app \(Terminals and devices: GET \/system\/links\)\./);
        // The remedy is the sandbox's, never this page's: a missing route proves which of the two is behind. (In a dev
        // build that remedy is the restart script; in a shipped one, updating the image.)
        expect(staleDaemonReason(LINKS)).not.toMatch(/reload this page/i);
    });

    it(`keeps the two kinds on their own evidence: procedures level, raw routes behind`, () => {
        sandbox(withoutLinks);
        expect(supportsRoute(`vpn.list`)).toBe(true);
        setDaemonRoutes(withoutVpn, SHAPES, undefined, { rawRoutes: RAW });
        expect([supportsRoute(LINKS), supportsRoute(`vpn.list`)]).toEqual([true, false]);
    });

    it(`reads one only the daemon has as the page being the older side`, () => {
        sandbox([...RAW, `GET /teleport`]);
        expect(unknownDaemonRoutes.value).toEqual([`GET /teleport`]);
        expect([appBehind.value, daemonBehind.value]).toEqual([true, false]);
    });

    it(`reports a raw route whose fields moved as drift, beside the procedures'`, () => {
        sandbox(RAW, { ...RAW_PRINTS, [LINKS]: `different` });
        expect(driftedRoutes.value).toEqual([LINKS]);
        expect(daemonDrifted.value).toBe(true);
    });

    it(`compares them only where both sides published a fingerprint`, () => {
        sandbox(RAW);
        expect([driftedRoutes.value, comparedRouteCount.value]).toEqual([[], Object.keys(SHAPES).length]);
    });
});

// The desktop app's sidecar serving a folder on this computer: it lists the few routes it has, and every other one is
// missing by nature, not because anything is out of date.
describe(`a folder on this computer`, () => {
    const FOLDER = [`workspace.tree`, `workspace.children`, `workspace.file`, `system.events`, `GET /workspace/raw`, `POST /workspace/upload`];
    beforeEach(() => resetSandboxScope());

    it(`gates on what it lists, and is neither behind nor ahead of this page`, () => {
        setDaemonRoutes(FOLDER, undefined, `folder`);
        expect([folderSurface.value, supportsRoute(`workspace.tree`), supportsRoute(`workspace.mkdir`)]).toEqual([true, true, false]);
        expect([missingRoutes.value, daemonBehind.value, unknownDaemonRoutes.value, appBehind.value]).toEqual([[], false, [], false]);
    });

    // A sidecar ships in one build with this page and lists its raw routes among the rest, so they are read from the
    // same field rather than from the one a daemon advertises them on.
    it(`gates its hand-written routes off the one list it sends`, () => {
        setDaemonRoutes(FOLDER, undefined, `folder`);
        expect([supportsRoute(`POST /workspace/upload`), supportsRoute(`POST /workspace/upload-diff`)]).toEqual([true, false]);
        expect([missingRoutes.value, daemonBehind.value]).toEqual([[], false]);
    });

    it(`says a missing route is not there for a folder, and never to update a sandbox`, () => {
        setDaemonRoutes(FOLDER, undefined, `folder`);
        expect(staleDaemonReason(`workspace.mkdir`)).toBe(`This part of the app (Files: workspace.mkdir) isn't available for a folder on this computer, only in a sandbox.`);
        expect(staleDaemonReason(`workspace.file`)).toBeUndefined();
    });

    // Every folder a desktop window shows is served by the one sidecar: a folder pointed at in the window's place is
    // reachable before its hello when it was last seen online, and must not read a sandbox's routes as served meanwhile.
    it(`carries the sidecar's routes to the next folder the window shows, until that folder's own hello`, () => {
        setDaemonRoutes(FOLDER, undefined, `folder`);
        resetSandboxScope();
        expect([folderSurface.value, supportsRoute(`workspace.tree`), supportsRoute(`settings.audience`)]).toEqual([true, true, false]);
        setDaemonRoutes([...FOLDER, `settings.audience`], undefined, `folder`);
        expect(supportsRoute(`settings.audience`)).toBe(true);
    });

    it(`reads a hello that names no surface as a sandbox's, as every daemon before the field sent`, () => {
        setDaemonRoutes(FOLDER, undefined, `folder`);
        setDaemonRoutes(withoutVpn);
        expect([folderSurface.value, daemonBehind.value]).toEqual([false, true]);
        expect(staleDaemonReason(`vpn.list`)).toMatch(/^This sandbox is too old for this part of the app \(VPN: vpn\.list\)\./);
    });

    // Another sandbox is another daemon, of its own age: what the last one said is no evidence about it.
    it(`carries nothing of a sandbox's hello across a switch`, () => {
        setDaemonRoutes(withoutVpn);
        resetSandboxScope();
        expect([folderSurface.value, supportsRoute(`vpn.list`)]).toEqual([false, true]);
    });
});
