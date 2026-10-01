// THE LEDGER BEHIND EVERY TURNING MARK ABOUT A MACHINE. What is pinned here is the part no component can hold: a run
// outlives the page that started it, an agent run outlives its own call, and only a reading of the machine ends one.
import type { Device } from "@intentic/sandbox-contract";
import {
    AGENT_RETURN_DEADLINE_MS,
    agentInFlight,
    agentReturned,
    agentReturnsPending,
    agentRunOf,
    beginDeviceWork,
    devicesWorking,
    dismissAgentRun,
    environmentWorking,
    forgetDeviceWork,
    machineCalling,
    machineWork,
    pressAgent,
    sandboxesWorking,
    settleAgentRuns,
} from "./deviceWork";

afterEach(forgetDeviceWork);

// One side of a PC, live, its agent serving the build on disk as process `pid`.
const side = (key: string, pid: number, installed = `1.321.0`): Device => ({
    key,
    label: key,
    hostId: key,
    online: true,
    report: {
        hostname: `rog`,
        os: `linux`,
        pairings: [],
        ports: [],
        agent: { running: true, pid, build: installed, installed, lastTickAt: Date.now() },
        capturedAt: Date.now(),
    },
});

const WAITING = `Updating. The new version shows here when its loop comes back.`;

const update = (moved: readonly Device[]) => {
    const [door] = moved;
    if (door === undefined) {
        throw new Error(`a press goes through a door`);
    }
    return pressAgent({ machine: `rog`, what: `Updating a machine's agents on rog`, op: `upgrade`, door, moved, waiting: WAITING });
};

it(`marks a call on its machine and its sandboxes until it ends, and nowhere else`, () => {
    expect(machineWork(`rog`)).toBeUndefined();
    const end = beginDeviceWork({ machine: `rog`, sandboxes: [`work`], doing: `Stopping work`, what: `Stopping work on rog` });
    expect(machineWork(`rog`)).toBe(`Stopping work`);
    expect(sandboxesWorking(`rog`)).toEqual([`work`]);
    expect(machineCalling(`rog`)).toBe(true);
    expect(devicesWorking()).toBe(`Stopping work on rog`);
    expect(machineWork(`omen`)).toBeUndefined();
    expect(machineCalling(`omen`)).toBe(false);
    end();
    end();
    expect(machineWork(`rog`)).toBeUndefined();
    expect(sandboxesWorking(`rog`)).toEqual([]);
    expect(devicesWorking()).toBeUndefined();
});

it(`counts rather than lists once more than one thing runs`, () => {
    const first = beginDeviceWork({ machine: `rog`, doing: `Pausing file syncing`, what: `Pausing file syncing on rog` });
    const second = beginDeviceWork({ machine: `omen`, doing: `Stopping work`, what: `Stopping work on omen` });
    expect(devicesWorking()).toBe(`2 running`);
    expect(machineWork(`rog`)).toBe(`Pausing file syncing`);
    second();
    expect(devicesWorking()).toBe(`Pausing file syncing on rog`);
    first();
});

// THE BUG THIS LEDGER EXISTS FOR: the update detaches on the machine and its call returns at once, which used to be the
// end of every mark while the agent was still a minute from coming back.
it(`keeps an agent update in flight past its call, until a reading shows a new process serving it`, () => {
    const windows = side(`rog`, 100);
    const distro = side(`rog::wsl:Arch`, 200);
    const press = update([windows, distro]);
    press.line(`Started upgrade (pid 8123), detached from this connection.`);
    expect(agentInFlight(`rog`)).toBe(`upgrade`);
    expect(agentInFlight(`rog::wsl:Arch`)).toBe(`upgrade`);
    expect(machineCalling(`rog`)).toBe(true);
    expect(machineWork(`rog`)).toBe(`Updating its agent…`);
    expect(devicesWorking()).toBe(`Updating a machine's agents on rog`);

    press.ended();
    expect(machineCalling(`rog`)).toBe(false);
    // Still in flight: the call ending was never the answer.
    expect(machineWork(`rog`)).toBe(`Waiting for its agent to come back…`);
    expect(devicesWorking()).toBe(`Updating a machine's agents on rog`);
    expect(environmentWorking(`rog`)).toBe(true);
    expect(environmentWorking(`rog::wsl:Arch`)).toBe(true);
    expect(agentInFlight(`rog`)).toBe(`upgrade`);
    expect(agentReturnsPending()).toBe(true);
    expect(agentRunOf(`rog`)).toEqual({
        op: `upgrade`,
        state: `waiting`,
        lines: [`Started upgrade (pid 8123), detached from this connection.`],
        said: undefined,
        waiting: WAITING,
        links: undefined,
        failure: undefined,
    });

    // The same processes answering: nothing has been replaced yet.
    settleAgentRuns([windows, distro], Date.now());
    expect(environmentWorking(`rog`)).toBe(true);

    // The distro comes back first; the door's side still waits, and the run is still the machine's.
    settleAgentRuns([windows, side(`rog::wsl:Arch`, 201, `1.322.0`)], Date.now());
    expect(environmentWorking(`rog::wsl:Arch`)).toBe(false);
    expect(agentRunOf(`rog::wsl:Arch`)).toBeUndefined();
    expect(environmentWorking(`rog`)).toBe(true);
    expect(devicesWorking()).toBe(`Updating a machine's agents on rog`);

    settleAgentRuns([side(`rog`, 101, `1.322.0`), side(`rog::wsl:Arch`, 201, `1.322.0`)], Date.now());
    expect(machineWork(`rog`)).toBeUndefined();
    expect(devicesWorking()).toBeUndefined();
    expect(agentReturnsPending()).toBe(false);
    expect(agentInFlight(`rog`)).toBeUndefined();
    // The door keeps its answer for the page until it is put away.
    expect(agentRunOf(`rog`)?.state).toBe(`done`);
    dismissAgentRun(`rog`);
    expect(agentRunOf(`rog`)).toBeUndefined();
});

it(`ends every side's wait on the machine's own sentence, and on its refusal`, () => {
    const answered = update([side(`rog`, 100), side(`rog::wsl:Arch`, 200)]);
    answered.answered(`Upgraded the agent: 1.321.0 → 1.322.0.`);
    answered.ended();
    expect(machineWork(`rog`)).toBeUndefined();
    expect(agentRunOf(`rog`)).toMatchObject({ state: `done`, said: `Upgraded the agent: 1.321.0 → 1.322.0.` });
    expect(agentRunOf(`rog::wsl:Arch`)).toBeUndefined();

    const refused = update([side(`rog`, 100)]);
    refused.refused({ notice: { tone: `danger`, title: `That device wouldn't update its agent.` } });
    refused.ended();
    expect(machineWork(`rog`)).toBeUndefined();
    expect(agentRunOf(`rog`)).toMatchObject({ state: `failed`, failure: { notice: { title: `That device wouldn't update its agent.` } } });
});

// A machine that never comes back is its state badge's to name, not a run every row keeps turning for.
it(`stops advertising a wait past its deadline, keeps the strip waiting, and still takes the agent back after`, () => {
    const windows = side(`rog`, 100);
    const press = update([windows]);
    press.ended();
    settleAgentRuns([], Date.now() + AGENT_RETURN_DEADLINE_MS + 1);
    expect(machineWork(`rog`)).toBeUndefined();
    expect(devicesWorking()).toBeUndefined();
    expect(agentReturnsPending()).toBe(false);
    expect(agentRunOf(`rog`)?.state).toBe(`waiting`);
    settleAgentRuns([side(`rog`, 101)], Date.now());
    expect(agentRunOf(`rog`)?.state).toBe(`done`);
});

it(`never counts a dismissal against a call still open`, () => {
    update([side(`rog`, 100)]);
    dismissAgentRun(`rog`);
    expect(agentRunOf(`rog`)?.state).toBe(`running`);
});

describe(`agentReturned`, () => {
    const asked = { pid: 100, installed: `1.321.0`, askedAt: Date.now() - 1_000 };

    it(`wants a different process, live and serving the build on disk`, () => {
        expect(agentReturned(side(`rog`, 100), asked)).toBe(false);
        expect(agentReturned(side(`rog`, 101), asked)).toBe(true);
        const asleep = { ...side(`rog`, 101), online: false };
        expect(agentReturned(asleep, asked)).toBe(false);
        const skewed = side(`rog`, 101, `1.322.0`);
        expect(agentReturned({ ...skewed, report: { ...skewed.report!, agent: { ...skewed.report!.agent, build: `1.321.0` } } }, asked)).toBe(false);
    });

    // An agent too old to stamp its pid: an install that moved answers, and failing that a reading taken after the press.
    it(`falls back to the install, then to when the reading was taken, where no pid was said`, () => {
        const unstamped = (installed: string, capturedAt: number): Device => {
            const device = side(`rog`, 0, installed);
            return { ...device, report: { ...device.report!, agent: { running: true, build: installed, installed }, capturedAt } };
        };
        expect(agentReturned(unstamped(`1.322.0`, asked.askedAt - 5_000), asked)).toBe(true);
        expect(agentReturned(unstamped(`1.321.0`, asked.askedAt - 5_000), asked)).toBe(false);
        expect(agentReturned(unstamped(`1.321.0`, asked.askedAt + 5_000), asked)).toBe(true);
    });
});
