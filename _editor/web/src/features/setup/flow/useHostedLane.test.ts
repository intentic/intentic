import "@intentic/testing/dom";
import type { HostedOffer, HostedStatus, SandboxSummary } from "@intentic/api-contract";
import { unstubbed } from "@intentic/testing";
import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import { type EffectScope, effectScope, ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { MAX_WAKES } from "./machinePower";
import { type HostedLaneHost, useHostedLane } from "./useHostedLane";
import { type SetupRowHost, useSetupRow } from "./useSetupRow";

// Pins the hosted lane headlessly: a provision lands only on the lane, rung and row it was asked for; stepping off the
// rung mid-provision waits only for the platform to take the machine back and ignores the provision's late answer; a
// refused hand-back leaves the rung where it was; the wait's one recovery rebuilds or restarts; and a machine down under
// a waiting reader is started a bounded number of times.

const draft = sandboxSummary({ id: `new`, token: `tok` });
const hostedRow = (over: Partial<SandboxSummary> = {}): SandboxSummary =>
    sandboxSummary({ id: `new`, token: `tok`, hosted: { region: `iad`, warm: true }, ...over });

// Every lane a case stands up is stopped after it, so none of them keeps the shared wall clock armed for the next.
const scopes: EffectScope[] = [];

const stage = (offer: HostedOffer = { enabled: true, remaining: 1 }) => {
    const rows: SetupRowHost[`sandbox`] = unstubbed(`sandbox`, { sandboxes: ref([]), select: mock(), remove: mock(async () => undefined) });
    const platform = {
        hostedOffer: mock(async () => offer),
        hostedStatus: mock(async (_input: { sandboxId: string }): Promise<HostedStatus> => ({ machine: `unknown` })),
        hostedRestart: mock(async (_input: { sandboxId: string }) => ({ ok: true as const })),
        wake: mock(async (_input: { sandboxId: string }) => ({ ok: true as const })),
    };
    const sandbox = {
        hostedProvision: mock(async (id: string, _token: string) => hostedRow({ id })),
        hostedRelease: mock(async (id: string) => sandboxSummary({ id, token: `tok` })),
    };
    const scope = effectScope();
    scopes.push(scope);
    const { row, hosted } = scope.run(() => {
        const setupRow = useSetupRow({ sandbox: rows, enter: mock(async () => undefined) });
        return {
            row: setupRow,
            hosted: useHostedLane({
                platform: unstubbed<HostedLaneHost[`platform`]>(`platform`, platform),
                sandbox: unstubbed<HostedLaneHost[`sandbox`]>(`sandbox`, sandbox),
                row: setupRow,
            }),
        };
    })!;
    hosted.recordOffer({ kind: `answered`, value: offer });
    // Read through a function, since a rung the test just set would otherwise read as that value forever after.
    const rung = () => hosted.machine.value;
    return { platform, sandbox, scope, row, hosted, rung };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    setSystemTime();
});

describe(`the hosted offer`, () => {
    it(`reads an unreachable platform as offering nothing, without claiming it answered`, () => {
        const { hosted } = stage();
        hosted.recordOffer({ kind: `unreachable` });
        expect(hosted.hostedRead.value).toEqual({ kind: `unreachable` });
        expect(hosted.hostedOffered.value).toBe(false);
    });

    it(`states a spent allowance, a full fleet and a switched-off account only while no machine is on the row`, () => {
        const { row, hosted } = stage({ enabled: true, remaining: 0, full: true, suspended: true, hours: { allowance: 40, remaining: 3 } });
        const facts = () => ({ spent: hosted.hostedSpent.value, full: hosted.hostedFull.value, suspended: hosted.hostedSuspended.value });
        expect(facts()).toEqual({ spent: true, full: true, suspended: true });
        expect(hosted.hostedHours.value).toEqual({ allowance: 40, remaining: 3 });
        row.created.value = hostedRow({ daemonUrl: `https://sandbox-abc.sbx.intentic.dev` });
        expect(facts()).toEqual({ spent: false, full: false, suspended: true });
        expect(hosted.hostedHost.value).toBe(`sandbox-abc.sbx.intentic.dev`);
    });
});

describe(`starting a machine`, () => {
    it(`puts one on the row and starts the wait's clock`, async () => {
        const { platform, sandbox, row, hosted } = stage();
        row.created.value = draft;
        hosted.machine.value = `hosted`;
        setSystemTime(new Date(`2026-09-23T10:00:00Z`));
        expect(await hosted.provisionHosted()).toBe(true);
        expect(sandbox.hostedProvision.mock.calls).toEqual([[`new`, `tok`]]);
        expect(row.created.value?.hosted).toEqual({ region: `iad`, warm: true });
        expect(hosted.hostedSince.value).toBe(Date.parse(`2026-09-23T10:00:00Z`));
        expect(hosted.lane.value).toEqual({ kind: `idle`, action: 1, asked: `machine` });
        expect(platform.hostedOffer).toHaveBeenCalledTimes(1);
    });

    it(`starts nothing without a row of the owner's, or while the lane is busy`, async () => {
        const { sandbox, row, hosted } = stage();
        expect(await hosted.provisionHosted()).toBe(false);
        row.created.value = sandboxSummary({ id: `shared`, token: null, role: `writer` });
        expect(await hosted.provisionHosted()).toBe(false);
        row.created.value = draft;
        hosted.machine.value = `hosted`;
        const first = hosted.provisionHosted();
        expect(await hosted.provisionHosted()).toBe(false);
        await first;
        expect(sandbox.hostedProvision).toHaveBeenCalledTimes(1);
    });

    it(`holds a refusal for room as a full fleet, apart from the notice`, async () => {
        const { sandbox, row, hosted } = stage();
        row.created.value = draft;
        hosted.machine.value = `hosted`;
        sandbox.hostedProvision.mockRejectedValueOnce(Object.assign(new Error(`no machines`), { status: 503 }));
        expect(await hosted.provisionHosted()).toBe(false);
        expect(hosted.hostedFull.value).toBe(true);
        expect(hosted.hostedError.value).toEqual({ tone: `danger`, title: `Couldn't start a machine for you right now.`, detail: `no machines` });
        await hosted.recheckCapacity();
        expect({ full: hosted.hostedFull.value, error: hosted.hostedError.value }).toEqual({ full: false, error: undefined });
    });
});

describe(`stepping off the hosted rung`, () => {
    it(`waits only for the platform to take the machine back, and ignores the provision's late answer`, async () => {
        const { sandbox, row, hosted, rung } = stage();
        const provisioning = Promise.withResolvers<SandboxSummary>();
        sandbox.hostedProvision.mockReturnValueOnce(provisioning.promise);
        row.created.value = draft;
        hosted.machine.value = `hosted`;
        const started = hosted.provisionHosted();
        await hosted.chooseMachine(`mine`);
        expect(sandbox.hostedRelease.mock.calls).toEqual([[`new`]]);
        expect(rung()).toBe(`mine`);
        expect(hosted.lane.value).toEqual({ kind: `idle`, action: 2, asked: `nothing` });
        provisioning.resolve(hostedRow());
        expect(await started).toBe(false);
        expect(row.created.value?.hosted).toBe(null);
    });

    it(`keeps the rung, and asks again next time, when the platform refuses the hand-back`, async () => {
        const { sandbox, row, hosted, rung } = stage();
        row.created.value = draft;
        hosted.machine.value = `hosted`;
        await hosted.provisionHosted();
        row.created.value = draft;
        sandbox.hostedRelease.mockRejectedValueOnce(new Error(`network`));
        await hosted.chooseMachine(`mine`);
        expect(rung()).toBe(`hosted`);
        expect(hosted.lane.value).toEqual({ kind: `idle`, action: 2, asked: `release` });
        expect(hosted.hostedError.value).toEqual({
            tone: `danger`,
            title: `Couldn't remove the machine we started. Try again in a moment.`,
            detail: `network`,
        });
        await hosted.chooseMachine(`mine`);
        expect(sandbox.hostedRelease).toHaveBeenCalledTimes(2);
        expect(rung()).toBe(`mine`);
    });

    it(`asks before handing back a machine the row carries, and moves only once it is gone`, async () => {
        const { sandbox, row, hosted } = stage();
        const after = () => ({ asked: hosted.handBackAsked.value, machine: hosted.machine.value, claimedAt: row.claimedAt.value });
        row.created.value = hostedRow();
        row.claimedAt.value = `2026-09-23T10:00:00Z`;
        hosted.machine.value = `hosted`;
        await hosted.chooseMachine(`mine`);
        expect(after()).toEqual({ asked: true, machine: `hosted`, claimedAt: `2026-09-23T10:00:00Z` });
        expect(sandbox.hostedRelease).not.toHaveBeenCalled();
        await hosted.confirmHandBack();
        expect(after()).toEqual({ asked: false, machine: `mine`, claimedAt: null });
    });

    it(`picks the hosted rung without starting anything`, async () => {
        const { sandbox, hosted } = stage();
        await hosted.chooseMachine(`hosted`);
        expect(hosted.machine.value).toBe(`hosted`);
        expect(sandbox.hostedProvision).not.toHaveBeenCalled();
    });
});

describe(`starting it over`, () => {
    it(`restarts the machine that is there, forgetting what it said`, async () => {
        const { platform, row, hosted } = stage();
        row.created.value = hostedRow();
        row.announced.value = true;
        hosted.machine.value = `hosted`;
        await hosted.restartHosted();
        expect(platform.hostedRestart.mock.calls).toEqual([[{ sandboxId: `new` }]]);
        expect(row.announced.value).toBe(false);
        expect(hosted.lane.value).toEqual({ kind: `idle`, action: 1, asked: `nothing` });
    });

    it(`builds a new machine when the old one's address was refused`, async () => {
        const { platform, sandbox, row, hosted } = stage();
        row.created.value = hostedRow();
        row.announceRefusal.value = { announced: `old.example.dev`, expected: `sandbox-abc.sbx.test` };
        hosted.machine.value = `hosted`;
        await hosted.restartHosted();
        expect(sandbox.hostedRelease.mock.calls).toEqual([[`new`]]);
        expect(sandbox.hostedProvision.mock.calls).toEqual([[`new`, `tok`]]);
        expect(platform.hostedRestart).not.toHaveBeenCalled();
    });

    it(`says so in its own words when a rebuild meets a full fleet`, async () => {
        const { sandbox, row, hosted } = stage();
        row.created.value = hostedRow();
        row.announceRefusal.value = { announced: `old.example.dev`, expected: `sandbox-abc.sbx.test` };
        hosted.machine.value = `hosted`;
        sandbox.hostedRelease.mockRejectedValueOnce(Object.assign(new Error(`full`), { code: `SERVICE_UNAVAILABLE` }));
        await hosted.restartHosted();
        expect(hosted.hostedError.value).toEqual({
            tone: `warning`,
            title: `We're out of machines right now, so we can't build you another one this minute.`,
        });
        expect(sandbox.hostedProvision).not.toHaveBeenCalled();
    });
});

describe(`a machine down under a waiting reader`, () => {
    const waiting = (reading: HostedStatus[`machine`]) => {
        setSystemTime(new Date(`2026-09-23T10:00:00Z`));
        const staged = stage();
        staged.row.created.value = hostedRow();
        staged.hosted.resumeHosted();
        staged.platform.hostedStatus.mockResolvedValue({ machine: reading });
        return staged;
    };

    it(`is started on the first reading that says so, and narrated as a boot`, async () => {
        const { platform, hosted } = waiting(`stopped`);
        await hosted.readMachine(`new`, hosted.lane.value.action);
        expect(platform.wake.mock.calls).toEqual([[{ sandboxId: `new` }]]);
        expect(hosted.hostedWait.value.failure).toBe(undefined);
    });

    it(`is read once every four polls`, async () => {
        const { platform, hosted } = waiting(`started`);
        for (let poll = 0; poll < 5; poll += 1) {
            await hosted.readMachine(`new`, hosted.lane.value.action);
        }
        expect(platform.hostedStatus).toHaveBeenCalledTimes(2);
    });

    it(`is started at most three times, thirty seconds apart`, async () => {
        const { platform, hosted } = waiting(`stopped`);
        const poll = async (at: number): Promise<void> => {
            setSystemTime(new Date(at));
            for (let read = 0; read < 4; read += 1) {
                await hosted.readMachine(`new`, hosted.lane.value.action);
            }
        };
        const start = Date.parse(`2026-09-23T10:00:00Z`);
        await poll(start);
        await poll(start + 10_000);
        expect(platform.wake).toHaveBeenCalledTimes(1);
        for (let at = start + 30_000; at <= start + 300_000; at += 30_000) {
            await poll(at);
        }
        expect(platform.wake).toHaveBeenCalledTimes(MAX_WAKES);
    });

    it(`is left alone for a reader who stepped over to their own computer`, async () => {
        const { platform, hosted } = waiting(`stopped`);
        hosted.machine.value = `mine`;
        await hosted.readMachine(`new`, hosted.lane.value.action);
        expect(platform.wake).not.toHaveBeenCalled();
    });

    it(`keeps a refused start as the account of why it is down`, async () => {
        const { platform, hosted } = waiting(`stopped`);
        platform.wake.mockRejectedValueOnce(Object.assign(new Error(`hours spent`), { status: 402 }));
        await hosted.readMachine(`new`, hosted.lane.value.action);
        expect(hosted.hostedWait.value.failure?.action).toBe(`none`);
    });

    it(`ignores a reading asked before the lane moved on`, async () => {
        const { platform, hosted } = waiting(`stopped`);
        const asked = hosted.lane.value.action;
        await hosted.restartHosted();
        await hosted.readMachine(`new`, asked);
        expect(platform.wake).not.toHaveBeenCalled();
    });
});

describe(`leaving the page`, () => {
    it(`drops a provision's answer that lands after it`, async () => {
        const { sandbox, scope, row, hosted } = stage();
        const provisioning = Promise.withResolvers<SandboxSummary>();
        sandbox.hostedProvision.mockReturnValueOnce(provisioning.promise);
        row.created.value = draft;
        hosted.machine.value = `hosted`;
        const started = hosted.provisionHosted();
        scope.stop();
        provisioning.resolve(hostedRow());
        expect(await started).toBe(false);
        expect(row.created.value).toEqual(draft);
    });
});
