import type { DeployAlert } from "./contract";
import { describe, expect, it } from "vitest";
import { incidents, incidentTone, incidentTooltip, topTier, unseenIncidents } from "./incidents";

const alert = (over: Partial<DeployAlert>): DeployAlert => ({
    id: `a`,
    type: `ContainerStateChange`,
    level: `critical`,
    resolved: false,
    ts: 1_000,
    ...over,
});

describe(`incidentTone`, () => {
    it(`badges a container that transitioned into a broken state`, () => {
        expect(incidentTone(alert({ from: `running`, to: `exited` }))).toBe(`danger`);
        expect(incidentTone(alert({ from: `running`, to: `restarting` }))).toBe(`danger`);
        expect(incidentTone(alert({ type: `StackStateChange`, from: `running`, to: `dead` }))).toBe(`danger`);
    });

    // The recovery direction. Even unresolved, a move back into running is not something to call anyone about.
    it(`stays silent on a transition back into running`, () => {
        expect(incidentTone(alert({ from: `restarting`, to: `running` }))).toBeUndefined();
        expect(incidentTone(alert({ from: `deploying`, to: `running` }))).toBeUndefined();
    });

    it(`treats an unreachable server and a failed build as breakages`, () => {
        expect(incidentTone(alert({ type: `ServerUnreachable` }))).toBe(`danger`);
        expect(incidentTone(alert({ type: `BuildFailed` }))).toBe(`danger`);
        expect(incidentTone(alert({ type: `ProcedureFailed` }))).toBe(`danger`);
    });

    it(`keeps thresholds at warning and image updates at info`, () => {
        expect(incidentTone(alert({ type: `ServerDisk` }))).toBe(`warning`);
        // The one that would otherwise relight the rail daily for something nobody needs to see today.
        expect(incidentTone(alert({ type: `DeploymentImageUpdateAvailable` }))).toBe(`info`);
        expect(incidentTone(alert({ type: `StackImageUpdateAvailable` }))).toBe(`info`);
    });

    it(`ignores what the system did to itself`, () => {
        expect(incidentTone(alert({ type: `DeploymentAutoUpdated` }))).toBeUndefined();
        expect(incidentTone(alert({ type: `ScheduleRun` }))).toBeUndefined();
        expect(incidentTone(alert({ type: `Test` }))).toBeUndefined();
        expect(incidentTone(alert({ type: `None` }))).toBeUndefined();
    });
});

describe(`incidents`, () => {
    it(`drops resolved alerts — a closed state-change alert is the recovery`, () => {
        const list = incidents([alert({ id: `open`, to: `exited`, ts: 2_000 }), alert({ id: `closed`, to: `exited`, ts: 1_000, resolved: true })]);
        expect(list.map((incident) => incident.alert.id)).toEqual([`open`]);
    });

    it(`orders newest first`, () => {
        const list = incidents([alert({ id: `old`, to: `dead`, ts: 1_000 }), alert({ id: `new`, to: `dead`, ts: 5_000 })]);
        expect(list.map((incident) => incident.alert.id)).toEqual([`new`, `old`]);
    });

    it(`phrases the transition in words, with the host`, () => {
        const [only] = incidents([alert({ resource: `api`, server: `prod-1`, from: `running`, to: `restarting` })]);
        expect(only?.summary).toBe(`api running → restarting on prod-1`);
    });

    it(`surfaces an alert variant it has never met rather than dropping it`, () => {
        // An unmapped variant carries no tone, so it does not badge — but the mapper must not throw on it,
        // and a mapped-but-unknown phrasing must still name the resource.
        expect(incidents([alert({ type: `SomethingKomodoAddedLater`, resource: `api` })])).toEqual([]);
        expect(incidentTone(alert({ type: `SomethingKomodoAddedLater` }))).toBeUndefined();
    });
});

describe(`unseenIncidents`, () => {
    // The property that keeps the badge meaningful through a multi-day outage.
    it(`goes quiet for an incident already looked at, however long it stays open`, () => {
        const open = incidents([alert({ to: `exited`, ts: 1_000 })]);
        expect(unseenIncidents(open, 2_000)).toEqual([]);
        expect(unseenIncidents(open, 500)).toHaveLength(1);
    });

    it(`counts everything when the view has never been opened`, () => {
        expect(unseenIncidents(incidents([alert({ to: `exited` })]), undefined)).toHaveLength(1);
    });
});

describe(`topTier`, () => {
    it(`reports only the worst tier — an outage is not diluted by pending version bumps`, () => {
        const list = incidents([
            alert({ id: `down`, resource: `api`, to: `exited`, ts: 3_000 }),
            alert({ id: `disk`, type: `ServerDisk`, resource: `prod-1`, ts: 2_000 }),
            alert({ id: `update`, type: `StackImageUpdateAvailable`, resource: `web`, ts: 1_000 }),
        ]);
        expect(topTier(list).map((incident) => incident.alert.id)).toEqual([`down`]);
    });

    it(`falls through to updates when nothing is broken`, () => {
        const list = incidents([alert({ id: `update`, type: `StackImageUpdateAvailable`, resource: `web` })]);
        expect(topTier(list).map((incident) => incident.tone)).toEqual([`info`]);
    });

    it(`is empty for an empty board`, () => {
        expect(topTier([])).toEqual([]);
    });
});

describe(`incidentTooltip`, () => {
    // "api exited on prod-1" is a fact someone can act on; "1" is not.
    it(`names the one thing when there is one thing`, () => {
        const list = incidents([alert({ resource: `api`, server: `prod-1`, from: `running`, to: `exited` })]);
        expect(incidentTooltip(list)).toBe(`api running → exited on prod-1`);
    });

    it(`counts once there is more than one, in the tier's own words`, () => {
        const broken = incidents([alert({ id: `a`, to: `exited`, ts: 2 }), alert({ id: `b`, to: `dead`, ts: 1 })]);
        expect(incidentTooltip(broken)).toBe(`2 needing you`);
        const updates = incidents([
            alert({ id: `c`, type: `StackImageUpdateAvailable`, ts: 2 }),
            alert({ id: `d`, type: `DeploymentImageUpdateAvailable`, ts: 1 }),
        ]);
        expect(incidentTooltip(updates)).toBe(`2 updates available`);
    });
});
