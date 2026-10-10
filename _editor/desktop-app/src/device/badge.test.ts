import { type DeviceSigns, deviceBadge } from "./badge";

// No catalog is registered here, so each message reads back as its own key: what is asserted is which message the tile
// says, and in which of the badge's shapes.
const AT_REST: DeviceSigns = { settingUp: false, sandbox: undefined, fixing: undefined, waiting: false, startingDocker: false, updateReady: false };

describe(`the This device tile`, () => {
    it(`says nothing about a computer at rest`, () => {
        expect(deviceBadge(AT_REST)).toBeUndefined();
    });

    it(`spins while a setup runs, ahead of everything else it could say`, () => {
        expect(deviceBadge({ ...AT_REST, settingUp: true, sandbox: `shop`, waiting: true, updateReady: true })).toEqual({
            running: `desktop.device.settingUpBadge`,
        });
    });

    it(`spins while the recovery panel's fix runs, naming the sandbox, ahead of what waits for the reader`, () => {
        expect(deviceBadge({ ...AT_REST, fixing: `shop`, waiting: true, updateReady: true })).toEqual({ running: `desktop.fix.fixing` });
    });

    it(`spins while the sandboxes move to another engine, behind a setup or a fix and ahead of what waits for the reader`, () => {
        expect(deviceBadge({ ...AT_REST, movingSandboxes: true, waiting: true, startingDocker: true })).toEqual({ running: `desktop.engine.movingBadge` });
        expect(deviceBadge({ ...AT_REST, movingSandboxes: true, fixing: `shop` })).toEqual({ running: `desktop.fix.fixing` });
        expect(deviceBadge({ ...AT_REST, movingSandboxes: false })).toBeUndefined();
    });

    it(`marks a setup or a sync that stopped for the reader, in the warning tone`, () => {
        expect(deviceBadge({ ...AT_REST, waiting: true, startingDocker: true })).toEqual({
            mark: `exclamation`,
            tone: `warning`,
            tooltip: `desktop.device.needsYouBadge`,
        });
    });

    it(`spins while this computer's own sandbox is made, behind a setup or a fix running here`, () => {
        expect(deviceBadge({ ...AT_REST, machine: `creating`, updateReady: true })).toEqual({ running: `desktop.device.machineBadge` });
        expect(deviceBadge({ ...AT_REST, machine: `interrupted` })).toEqual({ running: `desktop.device.machineBadge` });
        expect(deviceBadge({ ...AT_REST, machine: `creating`, fixing: `shop` })).toEqual({ running: `desktop.fix.fixing` });
    });

    it(`marks this computer's own sandbox waiting on the reader, and says nothing of one made or not yet asked for`, () => {
        for (const machine of [`waiting`, `failed`, `needsDocker`, `stopped`, `gone`] as const) {
            expect(deviceBadge({ ...AT_REST, machine })).toEqual({ mark: `exclamation`, tone: `warning`, tooltip: `desktop.device.needsYouBadge` });
        }
        expect(deviceBadge({ ...AT_REST, machine: `needsDocker`, startingDocker: true })).toEqual({ running: `desktop.device.startingDockerBadge` });
        expect(deviceBadge({ ...AT_REST, machine: `ready` })).toBeUndefined();
        expect(deviceBadge({ ...AT_REST, machine: `signedOut` })).toBeUndefined();
    });

    it(`spins while Docker is being started, and only then offers the update`, () => {
        expect(deviceBadge({ ...AT_REST, startingDocker: true, updateReady: true })).toEqual({ running: `desktop.device.startingDockerBadge` });
        expect(deviceBadge({ ...AT_REST, updateReady: true })).toEqual({ mark: `arrow-up`, tone: `info`, tooltip: `desktop.device.updateReadyBadge` });
    });
});
