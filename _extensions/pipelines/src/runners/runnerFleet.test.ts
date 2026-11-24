import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { messages } from "../i18n";
import { manifest } from "../manifest";
import type { CiFleet, CiFleetService, CiRunner, Device } from "./fleetTypes";
import {
    defaultLabels,
    fleetDevices,
    parseLabels,
    passViews,
    poolLine,
    runnerDoing,
    runnerPresses,
    runnerStatus,
    serviceLine,
    shownReads,
    suggestRunnerName,
} from "./runnerFleet";

// The Runners section's wording and gating: which computers it asks, which it draws, what a runner row says it is
// doing, and which presses the fleet service would take for it as it stands.

await registerExtensionMessages(extensionIdOf(manifest), messages);

const NOW = Date.parse(`2026-11-24T12:00:00Z`);
const UP: CiFleetService = { running: true, installed: true, version: `1.300.0` };

const runner = (over: Partial<CiRunner> & { name: string }): CiRunner => ({
    unit: `actions.runner.acme-shop.${over.name}.service`,
    dir: `/home/ci/actions-runner-${over.name}`,
    user: `ci`,
    light: false,
    state: `active`,
    busy: false,
    draining: false,
    ...over,
});

const fleet = (over: Partial<CiFleet> = {}): CiFleet => ({ service: UP, runners: [], cacheRoot: `/ci-cache`, caches: [], ...over });

const device = (over: Partial<Device> & { key: string }): Device => ({ label: over.key, ...over });

describe(`which computers it asks`, () => {
    it(`asks only live connections whose agent lists runners`, () => {
        const facts = (features: string[]): Device[`facts`] => ({ os: `Linux`, arch: `x64`, shell: `/bin/bash`, home: `/home/ci`, roots: [`/home/ci`], features });
        const devices = [
            device({ key: `z440`, hostId: `host-z440`, online: true, facts: facts([`stacks`, `ci-runners`]) }),
            device({ key: `omen`, hostId: `host-omen`, online: true, facts: facts([`stacks`]) }),
            device({ key: `inwin`, hostId: `host-inwin`, online: false, facts: facts([`ci-runners`]) }),
            device({ key: `laptop`, facts: facts([`ci-runners`]) }),
        ];

        expect(fleetDevices(devices)).toEqual([{ id: `host-z440`, label: `z440` }]);
    });

    it(`draws a computer with runners, with the service to add one, or whose read failed, and none other`, () => {
        const z440 = { id: `z440`, label: `z440` };
        const reads = [
            { device: z440, fleet: fleet({ runners: [runner({ name: `z440-worker-1` })] }) },
            { device: { id: `bare`, label: `bare` }, fleet: fleet({ service: { running: false, installed: false } }) },
            { device: { id: `fresh`, label: `fresh` }, fleet: fleet() },
            { device: { id: `off`, label: `off` }, error: `Run commands is off` },
        ];

        expect(shownReads(reads).map((read) => read.device.id)).toEqual([`z440`, `fresh`, `off`]);
        expect(shownReads([])).toEqual([]);
    });
});

describe(`a computer's head`, () => {
    it(`says the fleet service's state, and its problem when it is not answering`, () => {
        expect(serviceLine(UP).text).toContain(`v1.300.0`);
        expect(serviceLine({ running: false, installed: true, problem: `socket refused` })).toMatchObject({ tone: `warning`, problem: `socket refused` });
        expect(serviceLine({ running: false, installed: false }).tone).toBe(`neutral`);
    });

    it(`reads the test-memory pool as what CI may use`, () => {
        const line = poolLine({
            dir: `/ci-cache/slots`,
            total: 16,
            reserved: 2,
            floor: 2,
            heldForSandboxes: 5,
            sandboxBytes: 0,
            heldByCi: 3,
            free: 8,
            at: `2026-11-24T11:59:00Z`,
        });
        expect(line).toBe(`CI may use 11 of 16 test slots; 5 held for sandboxes`);
    });
});

describe(`a runner row`, () => {
    it(`spins while busy whatever systemd says, and reads a lost unit as failed`, () => {
        expect(runnerStatus(runner({ name: `a`, busy: true }))).toBe(`running`);
        expect(runnerStatus(runner({ name: `a` }))).toBe(`success`);
        expect(runnerStatus(runner({ name: `a`, state: `inactive` }))).toBe(`canceled`);
        expect(runnerStatus(runner({ name: `a`, state: `not-installed` }))).toBe(`failed`);
        expect(runnerStatus(runner({ name: `a`, state: `activating` }))).toBe(`queued`);
    });

    it(`says the job and how long it has run`, () => {
        const busy = runner({ name: `a`, busy: true, job: `test (2/4)`, busySince: `2026-11-24T11:55:00Z` });
        expect(runnerDoing(busy, NOW)).toBe(`Running test (2/4) for 5m`);
        expect(runnerDoing(runner({ name: `a`, busy: true }), NOW)).toBe(`Running a job`);
    });

    it(`says why a runner is down on purpose, a drain waiting, and a lost unit`, () => {
        expect(runnerDoing(runner({ name: `a`, state: `inactive`, held: `board` }), NOW)).toBe(`Stopped from here`);
        expect(runnerDoing(runner({ name: `a`, state: `inactive`, held: `smoke` }), NOW)).toBe(`Paused for a Windows smoke job`);
        expect(runnerDoing(runner({ name: `a`, draining: true }), NOW)).toBe(`Draining: stops when its job ends`);
        expect(runnerDoing(runner({ name: `a`, state: `not-installed` }), NOW)).toBe(`Its systemd unit is gone: register it again`);
        expect(runnerDoing(runner({ name: `a` }), NOW)).toBe(`Idle`);
    });
});

describe(`a runner's presses`, () => {
    it(`offers drain, restart and stop on a running one, and refuses stop and remove mid-job`, () => {
        const idle = runnerPresses(runner({ name: `a` }), UP);
        expect(idle.start).toBeUndefined();
        expect([idle.drain?.enabled, idle.restart?.enabled, idle.stop?.enabled, idle.remove.enabled]).toEqual([true, true, true, true]);

        const busy = runnerPresses(runner({ name: `a`, busy: true }), UP);
        expect(busy.stop).toEqual({ enabled: false, reason: `Running a job: drain it instead` });
        expect(busy.remove.enabled).toBe(false);
        expect(busy.drain?.enabled).toBe(true);
    });

    it(`offers start on a stopped, failed or held one`, () => {
        for (const over of [{ state: `inactive` as const }, { state: `failed` as const }, { held: `smoke` as const }]) {
            const presses = runnerPresses(runner({ name: `a`, ...over }), UP);
            expect(presses.start?.enabled).toBe(true);
            expect(presses.stop).toBeUndefined();
        }
    });

    it(`holds back a second drain, offers a lost unit only removal, and offers nothing without the service`, () => {
        expect(runnerPresses(runner({ name: `a`, draining: true }), UP).drain?.enabled).toBe(false);
        expect(runnerPresses(runner({ name: `a`, state: `not-installed` }), UP)).toEqual({ remove: { enabled: true } });
        const down = runnerPresses(runner({ name: `a` }), { running: false, installed: false });
        expect(down.start ?? down.stop ?? down.drain).toBeUndefined();
        expect(down.remove.enabled).toBe(false);
    });
});

describe(`adding a runner`, () => {
    it(`suggests one past the highest worker on the computer`, () => {
        const runners = [runner({ name: `z440-worker-1` }), runner({ name: `z440-worker-4` }), runner({ name: `z440-light-1` })];
        expect(suggestRunnerName({ id: `h`, label: `Z440 desk` }, runners)).toBe(`z440-worker-5`);
        expect(suggestRunnerName({ id: `h`, label: `Z440 desk` }, [])).toBe(`z440-desk-worker-1`);
    });

    it(`labels a light-lane name for that lane alone`, () => {
        expect(defaultLabels(`z440-light-2`)).toBe(`intentic-light`);
        expect(defaultLabels(`z440-worker-2`)).toBe(`intentic,desktop`);
        expect(parseLabels(` intentic, desktop ,,`)).toEqual([`intentic`, `desktop`]);
    });
});

describe(`the fleet's passes`, () => {
    it(`lists the passes it ran, with when and what they freed`, () => {
        const views = passViews(
            fleet({ janitor: { at: `2026-11-24T11:00:00Z`, dryRun: false, freedBytes: 2 * 1024 ** 3, lines: [`emptied _work`] } }),
            NOW,
        );
        expect(views.map((view) => view.kind)).toEqual([`janitor`]);
        expect(views[0]?.summary).toMatch(/freed/);
        expect(views[0]?.lines).toEqual([`emptied _work`]);
    });
});
