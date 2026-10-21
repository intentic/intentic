import "@intentic/testing/dom";
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import { computed, type EffectScope, effectScope, nextTick, ref } from "vue";
import { listedDevice } from "../../../testing/listedDevice";
import { forgetOperations } from "../../../workbench/operations/operations";

// Where the own-computer setup runs: this computer's own way, or a connected machine picked in the "Runs on" row. A pick
// starts nothing (a stray click on a machine once started a sandbox there, with no way to call it off); only the one
// button sends `create`, to the machine picked, through the sandbox that reaches it, with this row's code.

const relays = ref<{ sandboxId: string; devices: Device[] }[]>([]);
const look = jest.fn(async () => {});
const followed: (() => boolean)[] = [];
jest.mock(`../../sandbox/live/useDeviceRelays`, () => ({
    useDeviceRelays: (options: { follow?: () => boolean } = {}) => {
        if (options.follow !== undefined) {
            followed.push(options.follow);
        }
        return { relays: computed(() => relays.value), looking: ref(false), look };
    },
}));
const manageDeviceSandbox = jest.fn(async () => `Set up.`);
jest.mock(`../../../models/sandbox/devices/useDevices`, () => ({ manageDeviceSandbox }));
jest.mock(`../../../app/analytics`, () => ({ track: jest.fn() }));

const { HERE, useSetupOnMachine } = await import("./useSetupOnMachine");

const omen = listedDevice({ key: `omen`, label: `omen`, hostId: `omen`, online: true, sandboxes: [] });
const rog = listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, online: true, sandboxes: [] });
const scopes: EffectScope[] = [];

const stage = (over: { offered?: boolean; mobile?: boolean } = {}) => {
    const offered = ref(over.offered ?? true);
    const mobile = ref(over.mobile ?? false);
    const scope = effectScope();
    scopes.push(scope);
    const machine = scope.run(() =>
        useSetupOnMachine({
            offered: () => offered.value,
            created: ref({ id: `row-1` }),
            setup: ref({ code: `ABCD-1234`, hostname: `sandbox-7e8d0ffa8bed.radarsu.com` }),
            mobile,
        }),
    )!;
    return { machine, offered, mobile };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    relays.value = [];
    followed.length = 0;
    look.mockClear();
    manageDeviceSandbox.mockClear();
    forgetOperations();
});

it(`reads no sandbox's devices while a press could not do what the command would, and asks fresh once it could`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    const { machine, offered } = stage({ offered: false });
    expect(look).not.toHaveBeenCalled();
    expect(followed[0]?.()).toBe(false);
    expect(machine.doors.value).toEqual([]);
    offered.value = true;
    await nextTick();
    expect(look).toHaveBeenCalledTimes(1);
    expect(followed[0]?.()).toBe(true);
    expect(machine.doors.value.map((door) => door.machineLabel)).toEqual([`omen`]);
});

it(`stays on this computer's own way until a machine is picked, and a pick starts nothing`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen, rog] }];
    const { machine } = stage();
    expect(machine.target.value).toBe(HERE);
    expect(machine.door.value).toBeUndefined();
    machine.target.value = `rog`;
    await nextTick();
    expect(machine.door.value?.machineLabel).toBe(`rog`);
    expect(manageDeviceSandbox).not.toHaveBeenCalled();
});

// A phone has no computer of its own to run the command on: a connected machine is its one press.
it(`starts a phone on its first connected machine`, () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    expect(stage({ mobile: true }).machine.target.value).toBe(`omen`);
});

it(`goes back to this computer's way when the machine picked is no longer on offer`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    const { machine } = stage();
    machine.target.value = `omen`;
    relays.value = [{ sandboxId: `intentic`, devices: [{ ...omen, online: false }] }];
    await nextTick();
    expect(machine.target.value).toBe(HERE);
    expect(machine.door.value).toBeUndefined();
});

it(`sets it up on the machine picked, through the sandbox that reaches it, with this row's code`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    const { machine } = stage();
    await machine.setUpOn();
    expect(manageDeviceSandbox).not.toHaveBeenCalled();
    machine.target.value = `omen`;
    await machine.setUpOn();
    expect(manageDeviceSandbox).toHaveBeenCalledWith(
        `omen`,
        `sandbox-7e8d0ffa8bed`,
        `create`,
        expect.objectContaining({ setupCode: `ABCD-1234`, at: `intentic` }),
    );
});

// The flow drops the machine's cached reading as it runs, so a re-read could lose it from the list mid-run.
it(`keeps the machine a press went to while it runs, whatever the list says meanwhile`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    let finish: (said: string) => void = () => undefined;
    manageDeviceSandbox.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
    const { machine } = stage();
    machine.target.value = `omen`;
    const running = machine.setUpOn();
    relays.value = [];
    await nextTick();
    expect(machine.door.value?.machineLabel).toBe(`omen`);
    expect(machine.target.value).toBe(`omen`);
    finish(`Set up.`);
    await running;
    await nextTick();
    expect(machine.target.value).toBe(HERE);
});
