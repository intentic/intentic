// THE LEDGER BEHIND A HUB ROW'S TURNING MARK. What is pinned here is the part a component cannot hold: a run
// survives the section that started it, the row it belongs to, and how a row with several runs describes itself.
import { waitFor } from "@intentic/testing/bun";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { beginHubWork, forgetHubWork, hubWorkKey, hubWorkRunning, trackHubWork } from "./hubWork";

const DEVICES = hubWorkKey(`sandbox`, `devices`);
const ENVIRONMENT = hubWorkKey(`sandbox`, `environment`);

afterEach(forgetHubWork);

it(`says nothing until something runs, the run's own words while it does, and nothing again after`, () => {
    expect(hubWorkRunning(DEVICES)).toBeUndefined();
    const end = beginHubWork(DEVICES, `Updating a container`);
    expect(hubWorkRunning(DEVICES)).toBe(`Updating a container`);
    end();
    expect(hubWorkRunning(DEVICES)).toBeUndefined();
});

// A run that outlasts a glance says for how long, on the ledger's own clock, so a stuck one reads differently from a fresh one.
it(`says how long a run has been going once it outlasts a glance`, async () => {
    const start = Date.now();
    const now = jest.spyOn(Date, `now`).mockReturnValue(start);
    const end = beginHubWork(DEVICES, `Cloning acme`);
    expect(hubWorkRunning(DEVICES)).toBe(`Cloning acme`);
    now.mockReturnValue(start + 72_000);
    // The clock ticks once a second; three is a hang bound, not a latency.
    await waitFor(() => expect(hubWorkRunning(DEVICES)).toBe(`Cloning acme · 1m 12s`), { timeout: 3_000 });
    end();
    now.mockRestore();
});

// A row is four pixels of glance, so a second run turns the sentence into a number rather than a list.
it(`counts once a row holds more than one run, and speaks again when one is left`, () => {
    const first = beginHubWork(DEVICES, `Updating a container`);
    const second = beginHubWork(DEVICES, `Restarting an agent`);
    expect(hubWorkRunning(DEVICES)).toBe(`2 running`);
    second();
    expect(hubWorkRunning(DEVICES)).toBe(`Updating a container`);
    first();
});

it(`keeps one row's runs off another's`, () => {
    const end = beginHubWork(ENVIRONMENT, `Rebuilding from your checkout`);
    expect(hubWorkRunning(DEVICES)).toBeUndefined();
    expect(hubWorkRunning(ENVIRONMENT)).toBe(`Rebuilding from your checkout`);
    end();
});

// A mark left turning over a run that already failed is worse than no mark at all.
it(`ends a tracked run whether the work resolves or throws`, async () => {
    await trackHubWork(DEVICES, `Updating a container`, async () => {
        expect(hubWorkRunning(DEVICES)).toBe(`Updating a container`);
    });
    expect(hubWorkRunning(DEVICES)).toBeUndefined();

    await expect(trackHubWork(DEVICES, `Updating a container`, () => Promise.reject(new Error(`that device said no`)))).rejects.toThrow(
        `that device said no`,
    );
    expect(hubWorkRunning(DEVICES)).toBeUndefined();
});

it(`ends a run once however often it is told to`, () => {
    const end = beginHubWork(DEVICES, `Updating a container`);
    const other = beginHubWork(DEVICES, `Restarting an agent`);
    end();
    end();
    expect(hubWorkRunning(DEVICES)).toBe(`Restarting an agent`);
    other();
});

// A rebuild runs on the box it was started on: another sandbox's row does not turn for it, and the first box's still
// does once it is back on screen.
it(`marks a sandbox's row only for the work begun on that sandbox`, () => {
    activeSandboxId.value = `box-a`;
    const end = beginHubWork(ENVIRONMENT, `Rebuilding from your checkout`);
    activeSandboxId.value = `box-b`;

    expect(hubWorkRunning(ENVIRONMENT, `box-b`)).toBeUndefined();
    expect(hubWorkRunning(ENVIRONMENT, `box-a`)).toBe(`Rebuilding from your checkout`);
    // A row about no one sandbox (the settings hub's) counts it wherever it began.
    expect(hubWorkRunning(ENVIRONMENT)).toBe(`Rebuilding from your checkout`);
    end();
    activeSandboxId.value = undefined;
});
