import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { MachineSandbox } from "../desktop";

// This computer's sandbox as a window holds it: the app's record read on opening, then every change heard, an older
// answer never put back over a newer one; its requirements made whole for This device's card; and every press sent to
// the app as the command it is, with a refusal said beside it. The app is Tauri's own IPC mock.

const load = () => freshImport<typeof import("./machineSandbox")>("./machineSandbox", import.meta.url);

const RECORD: MachineSandbox = {
    state: `creating`,
    phase: `starting-sandbox`,
    percent: 52,
    sandboxId: `cmmachine0001`,
    name: `ada-laptop sandbox`,
    made: false,
    attempt: 1,
    updatedAt: 100,
    consented: false,
    resumeOnLaunch: false,
    requirements: [],
    folders: [],
};

let calls: { command: string; args: unknown }[] = [];
let status: MachineSandbox = RECORD;
let refuse: string | undefined;

beforeEach(() => {
    calls = [];
    status = RECORD;
    refuse = undefined;
    mockIPC(
        (command, args) => {
            calls.push({ command, args });
            if (refuse !== undefined && command !== `machine_sandbox_status`) {
                throw new Error(refuse);
            }
            return command === `machine_sandbox_status` ? status : null;
        },
        { shouldMockEvents: true },
    );
});
afterEach(() => clearMocks());

it(`reads the record on opening and follows every change the app sends`, async () => {
    const store = await load();
    await store.startMachineSandbox();
    expect(store.machineSandbox.value).toEqual(RECORD);
    await emit(`desktop://machine-sandbox`, { ...RECORD, state: `ready`, updatedAt: 101 });
    expect(store.machineSandbox.value?.state).toBe(`ready`);
    // Asked once per window, however many readers start it.
    await store.startMachineSandbox();
    expect(calls.filter((call) => call.command === `machine_sandbox_status`)).toHaveLength(1);
});

it(`never puts an older record back over a newer one`, async () => {
    const store = await load();
    store.heard({ ...RECORD, state: `ready`, updatedAt: 200 });
    store.heard({ ...RECORD, state: `creating`, updatedAt: 150 });
    expect(store.machineSandbox.value?.state).toBe(`ready`);
    // A change sent in the same second as the one held came after it.
    store.heard({ ...RECORD, state: `stopped`, updatedAt: 200 });
    expect(store.machineSandbox.value?.state).toBe(`stopped`);
    // The opening read answering late, with what it saw before those changes, changes nothing.
    status = { ...RECORD, updatedAt: 200 };
    await store.startMachineSandbox();
    expect(store.machineSandbox.value?.state).toBe(`stopped`);
});

it(`hands This device's card the requirements whole, and only those with an id`, async () => {
    const store = await load();
    store.heard({
        ...RECORD,
        state: `waiting`,
        for: `consent`,
        updatedAt: 300,
        requirements: [{ id: `wsl-features`, action: `fixElevated` }, { title: `no id` }, `not an object`],
    } as MachineSandbox);
    expect(store.machineRequirements.value).toEqual([{ id: `wsl-features`, title: `wsl-features`, problem: ``, remedy: ``, action: `fixElevated` }]);
});

it(`finds a folder by the path its window is told`, async () => {
    const store = await load();
    const record: MachineSandbox = { ...RECORD, folders: [{ path: `/home/ada/shop`, name: `shop`, state: `copying` }] };
    expect(store.machineFolderOf(record, `/home/ada/shop`)?.name).toBe(`shop`);
    expect(store.machineFolderOf(record, `/home/ada`)).toBeUndefined();
    expect(store.machineFolderOf(record, undefined)).toBeUndefined();
});

it(`sends each press to the app as its command`, async () => {
    const store = await load();
    await store.retryMachine(true);
    await store.retryMachine();
    await store.recreateMachine();
    await store.startMachine();
    await store.checkMachine();
    await store.endMachineSession(`restart`);
    expect(calls.map((call) => [call.command, call.args])).toEqual([
        [`machine_sandbox_retry`, { consent: true }],
        [`machine_sandbox_retry`, { consent: false }],
        [`machine_sandbox_recreate`, {}],
        [`machine_sandbox_start`, {}],
        [`machine_sandbox_check`, {}],
        [`machine_sandbox_end_session`, { how: `restart` }],
    ]);
    expect(store.machineStarting.value).toBe(false);
});

it(`says why a press did nothing, and clears it at the next`, async () => {
    const store = await load();
    refuse = `This computer's sandbox isn't on this computer yet.`;
    await store.startMachine();
    expect(store.machineActionError.value).toContain(`isn't on this computer yet`);
    refuse = undefined;
    await store.retryMachine();
    expect(store.machineActionError.value).toBeUndefined();
});
