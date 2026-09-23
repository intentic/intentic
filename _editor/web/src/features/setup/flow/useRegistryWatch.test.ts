import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { hostedWaitView } from "../hostedWait";
import { HOSTED_IDLE, type HostedLane } from "./hostedLane";
import type { Machine } from "./machineLadder";
import { useRegistryWatch } from "./useRegistryWatch";
import { type SetupRowHost, useSetupRow } from "./useSetupRow";

// Pins the registry watch: the claim and the machine's report are recorded only for the code still on screen, the
// workspace opens once the daemon checks in past the baseline and never while the hosted wait holds its card, a row
// re-issued elsewhere or an answer from before a hand-back changes nothing, and a lost read is named, then cleared.

const pending = sandboxSummary({ id: `s1`, token: `tok` });
const waitView = (over: Partial<Parameters<typeof hostedWaitView>[0]> = {}) =>
    hostedWaitView({
        machine: undefined,
        boot: null,
        refusal: null,
        announced: false,
        warm: true,
        waitedMs: 0,
        downForMs: 0,
        waking: false,
        wakeRefusal: undefined,
        ...over,
    });

const scopes: EffectScope[] = [];

// `opened` is the row this page settled on; the registry answers `rows`.
const stage = (rows: readonly SandboxSummary[] = [pending], opened: SandboxSummary = pending) => {
    const setupRows = unstubbed<SetupRowHost[`sandbox`]>(`sandbox`, { sandboxes: ref([]), select: mock(), remove: mock(async () => undefined) });
    const enter = mock(async () => undefined);
    const refresh = mock(async () => [...rows]);
    const hosted = {
        machine: ref<Machine>(`mine`),
        lane: ref<HostedLane>(HOSTED_IDLE),
        hostedRow: ref<SandboxSummary[`hosted`]>(null),
        hostedWait: ref(waitView()),
        readMachine: mock(async (_id: string, _action: number) => undefined),
    };
    const mintedFor = ref<string | undefined>(`s1:tok`);
    const scope = effectScope();
    scopes.push(scope);
    const { row, watcher } = scope.run(() => {
        const setupRow = useSetupRow({ sandbox: setupRows, enter });
        return { row: setupRow, watcher: useRegistryWatch({ sandbox: { refresh }, row: setupRow, hosted, mintedFor }) };
    })!;
    row.created.value = opened;
    return { enter, refresh, hosted, mintedFor, scope, row, watcher };
};

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    jest.useRealTimers();
});

describe(`what the registry says about the row`, () => {
    it(`records the claim and the machine's report for the code on screen`, async () => {
        const report = { stage: `pulling-image` as const, failed: [], at: `2026-09-23T10:01:00Z` };
        const { row, watcher } = stage([{ ...pending, setupCodeClaimedAt: `2026-09-23T10:00:00Z`, setupReport: report }]);
        await watcher.check();
        expect({ claimedAt: row.claimedAt.value, report: row.report.value }).toEqual({ claimedAt: `2026-09-23T10:00:00Z`, report });
    });

    it(`drops them when the code was minted again while the registry answered`, async () => {
        const { refresh, mintedFor, row, watcher } = stage();
        refresh.mockImplementationOnce(async () => {
            mintedFor.value = `s1:tok-2`;
            return [{ ...pending, setupCodeClaimedAt: `2026-09-23T10:00:00Z` }];
        });
        await watcher.check();
        expect(row.claimedAt.value).toBe(null);
    });

    it(`records what the daemon said about itself, and reads a hosted machine's power`, async () => {
        const hostedPending = { ...pending, hosted: { region: `iad`, warm: true }, announceRefusal: { announced: `a.dev`, expected: `b.dev` } };
        const { hosted, row, watcher } = stage([hostedPending]);
        hosted.machine.value = `hosted`;
        await watcher.check();
        expect(row.announceRefusal.value).toEqual({ announced: `a.dev`, expected: `b.dev` });
        expect(hosted.readMachine.mock.calls).toEqual([[`s1`, 0]]);
    });

    it(`ignores a row re-issued to another machine while the reader waits on their own`, async () => {
        const { row, watcher } = stage([{ ...pending, token: `other`, setupCodeClaimedAt: `2026-09-23T10:00:00Z` }]);
        await watcher.check();
        expect(row.claimedAt.value).toBe(null);
    });
});

describe(`opening the workspace`, () => {
    it(`opens it once the daemon checks in past the baseline`, async () => {
        const { enter, row, watcher } = stage([{ ...pending, lastSeenAt: `2026-09-23T10:02:00Z` }]);
        await watcher.check();
        expect(enter).toHaveBeenCalledTimes(1);
        expect(row.finished.value).toBe(true);
    });

    it(`does not count the boot the row already had`, async () => {
        const booted = { ...pending, lastSeenAt: `2026-09-23T09:00:00Z` };
        const { enter, row, watcher } = stage([booted], booted);
        await nextTick();
        await watcher.check();
        expect(row.baseline.value).toBe(`2026-09-23T09:00:00Z`);
        expect(enter).not.toHaveBeenCalled();
    });

    it(`holds the hosted wait on its card until the daemon is reachable`, async () => {
        const { enter, hosted, watcher } = stage([{ ...pending, hosted: { region: `iad`, warm: true }, lastSeenAt: `2026-09-23T10:02:00Z` }]);
        hosted.machine.value = `hosted`;
        hosted.hostedRow.value = { region: `iad`, warm: true };
        hosted.hostedWait.value = waitView({ announced: true, boot: { reach: `checking`, at: `2026-09-23T10:02:00Z` } });
        await watcher.check();
        expect(enter).not.toHaveBeenCalled();
        hosted.hostedWait.value = waitView({ announced: true, boot: { reach: `reachable`, at: `2026-09-23T10:02:30Z` } });
        await watcher.check();
        expect(enter).toHaveBeenCalledTimes(1);
    });

    it(`opens nothing from an answer that lands after a hand-back began`, async () => {
        const { enter, refresh, hosted, watcher } = stage([{ ...pending, lastSeenAt: `2026-09-23T10:02:00Z` }]);
        refresh.mockImplementationOnce(async () => {
            hosted.lane.value = { kind: `releasing`, action: 1, asked: `release` };
            return [{ ...pending, lastSeenAt: `2026-09-23T10:02:00Z` }];
        });
        await watcher.check();
        expect(enter).not.toHaveBeenCalled();
    });

    it(`asks nothing while a hand-back is unconfirmed`, async () => {
        const { refresh, hosted, watcher } = stage();
        hosted.lane.value = { kind: `idle`, action: 1, asked: `release` };
        await watcher.check();
        expect(refresh).not.toHaveBeenCalled();
    });
});

describe(`the watch itself`, () => {
    it(`reads every three seconds, never two at once, and stops with the page`, async () => {
        const { refresh, scope, watcher } = stage();
        const slow = Promise.withResolvers<SandboxSummary[]>();
        refresh.mockReturnValueOnce(slow.promise);
        await advanceTimersByTimeAsync(3_000);
        await watcher.check();
        expect(refresh).toHaveBeenCalledTimes(1);
        slow.resolve([pending]);
        await advanceTimersByTimeAsync(3_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        scope.stop();
        await advanceTimersByTimeAsync(9_000);
        window.dispatchEvent(new Event(`focus`));
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it(`checks at once when the reader comes back to the tab`, () => {
        const { refresh } = stage();
        window.dispatchEvent(new Event(`focus`));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it(`names a lost read, and clears it once the platform answers again`, async () => {
        const { refresh, watcher } = stage();
        refresh.mockRejectedValueOnce(new Error(`offline`));
        await watcher.check();
        expect(watcher.status.value).toBe(`Can't reach the platform to check. Retrying…`);
        await watcher.check();
        expect(watcher.status.value).toBe(undefined);
    });
});
