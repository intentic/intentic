import "@intentic/testing/dom";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { providerAccounts, providerSwitchOffs, setCapacitySnapshot, setProviderCapacity } from "../../providers/providerAccounts";
import { daemonPlacement, placementKey, placementsStale } from "../../providers/capacity/daemonPlacement";
import { setDaemonRoutes } from "../../../client/sandbox/useDaemonRoutes";
import { queryClient } from "../../../lib/queryPersistence";
import { Conversation } from "../session/conversation";
import { runServing, runSpentUntil, spentUntilOf } from "./runServing";

// One answer to "would a turn on this pick meet a spent allowance, and until when", read by the composer's Send and by
// every press that starts an agent. A Fix button once sent a run straight into a refusal on a model whose composer would
// have booked the same words for the reopen (2026-10-28).

const MODEL = `claude-opus-5-5`;
const NOW = 1_800_000_000_000;
// An hour after NOW, in the epoch seconds a reading names.
const REOPENS = NOW / 1_000 + 3_600;

const reading = (utilization: number): AccountUsage => ({
    measuredAt: NOW,
    windows: [{ kind: `five_hour`, gates: `all`, utilization, resetsAt: REOPENS }],
});
const account = (id: string, utilization: number): OauthAccount => ({ id, label: id, connectedAt: 1, usage: reading(utilization) });

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
    jest.useRealTimers();
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
    providerSwitchOffs.value = {};
});

test(`a run on a model whose only account is spent waits for its reopen, the instant the composer's Send books`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [account(`work`, 100)] };
    const chat = new Conversation(`c1`);
    chat.selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: MODEL } });

    expect(runSpentUntil({ provider: `claude`, model: MODEL }, NOW)).toBe(REOPENS * 1_000);
    expect(spentUntilOf(chat.selection.servingState.value, NOW)).toBe(REOPENS * 1_000);
});

test(`room on another account lets the run go now, where the runtime would place it there`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [account(`work`, 100), account(`spare`, 20)] };

    expect(runSpentUntil({ provider: `claude`, model: MODEL }, NOW)).toBeUndefined();
});

test(`an account the pick names is judged alone: another's room pays nothing for it`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [account(`work`, 100), account(`spare`, 20)] };

    expect(runSpentUntil({ provider: `claude`, model: MODEL, account: `work` }, NOW)).toBe(REOPENS * 1_000);
});

test(`a reopen the clock has passed is a stale reading, and the run goes now`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [account(`work`, 100)] };

    expect(runSpentUntil({ provider: `claude`, model: MODEL }, REOPENS * 1_000 + 1)).toBeUndefined();
});

// The daemon ranks an account its organisation keeps switching off behind a steady one of the same tier (plan-pools.ts
// preferredAccount). The window ticked the flapping one as "Auto" while every turn naming no account ran on the other,
// because the switch-offs never reached it (2026-11-15).
test(`a turn naming no account runs where the daemon places it: an account switched off twice this week ranks behind a steady one`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [account(`org`, 10), account(`own`, 90)] };
    expect(runServing({ provider: `claude`, harness: `native`, model: MODEL }).account).toEqual({ id: `org`, byAllowance: true });

    providerSwitchOffs.value = { claude: { org: [NOW - 3 * 86_400_000, NOW - 86_400_000] } };
    expect(runServing({ provider: `claude`, harness: `native`, model: MODEL }).account).toEqual({ id: `own`, byAllowance: true });
});

test(`one switch-off, or two a week apart, is not flapping`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [account(`org`, 10), account(`own`, 90)] };
    providerSwitchOffs.value = { claude: { org: [NOW - 8 * 86_400_000, NOW - 86_400_000] } };

    expect(runServing({ provider: `claude`, harness: `native`, model: MODEL }).account?.id).toBe(`org`);
});

// The daemon places a turn naming no account with what already runs on each account counted (placement.ts): the picker's
// tick, the composer's pill and the account a first turn names show its answer, and this window's prediction (the rows'
// own ranking above) only stands in against a daemon that does not give one.
describe(`where the daemon places a turn naming no account`, () => {
    afterEach(() => {
        setDaemonRoutes(undefined);
        setCapacitySnapshot({ providers: [] });
        queryClient.removeQueries({ queryKey: [`usage.placement`] });
    });

    it(`is the daemon's own pick, over the account the verdicts alone rank first`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [account(`org`, 10), account(`own`, 90)] };

        const placed = runServing({ provider: `claude`, harness: `native`, model: MODEL }, () => ({ kind: `placed`, account: `own` }));
        expect(placed.account).toEqual({ id: `own`, byAllowance: true });
        expect(placed.state).toMatchObject({ kind: `ready` });
    });

    it(`is predicted here against a daemon whose hello does not name the route`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [account(`org`, 10), account(`own`, 90)] };
        setDaemonRoutes([`usage.capacity`]);

        expect(daemonPlacement(`claude`, MODEL)).toBeUndefined();
        expect(runServing({ provider: `claude`, harness: `native`, model: MODEL }).account).toEqual({ id: `org`, byAllowance: true });
    });

    it(`is the capacity's pick for a turn naming no model, and the daemon's cached answer for one model`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [account(`org`, 10), account(`own`, 90)] };
        setDaemonRoutes([`usage.capacity`, `usage.placement`]);
        setProviderCapacity({ provider: `claude`, seq: 1, judgedAt: NOW, accounts: [], refusals: [], placement: `own` });
        // A daemon from before `loop` answers the sandbox-wide pick, without `narrowed`.
        queryClient.setQueryData(placementKey(`claude`, ``), { account: `org`, judgedAt: NOW });
        queryClient.setQueryData(placementKey(`claude`, MODEL, `claude-code`), { account: `own`, judgedAt: NOW });

        expect(daemonPlacement(`claude`, ``)).toEqual({ kind: `placed`, account: `own` });
        expect(runServing({ provider: `claude`, harness: `native`, model: MODEL }).account).toEqual({ id: `own`, byAllowance: true });

        // A capacity frame for the provider: the answer may have moved, so the next surface that shows it asks again.
        placementsStale(`claude`);
        expect(queryClient.getQueryState(placementKey(`claude`, MODEL, `claude-code`))?.isInvalidated).toBe(true);
    });

    // usage.placement narrowed to the chat's loop and the accounts this person may run on (2026-11-19): the turn's own
    // answer, over the capacity's sandbox-wide pick, and over this window's rows where they have not caught up.
    it(`is asked with the chat's loop, and a narrowed answer is the turn's own`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [account(`org`, 10), account(`own`, 90)] };
        setDaemonRoutes([`usage.capacity`, `usage.placement`]);
        setProviderCapacity({ provider: `claude`, seq: 1, judgedAt: NOW, accounts: [], refusals: [], placement: `org` });
        queryClient.setQueryData(placementKey(`claude`, ``, `claude-code`), { account: `own`, judgedAt: NOW, narrowed: true });

        expect(daemonPlacement(`claude`, ``, `claude-code`)).toEqual({ kind: `placed`, account: `own`, narrowed: true });
        expect(runServing({ provider: `claude`, harness: `native`, model: `` }).account).toEqual({ id: `own`, byAllowance: true });

        queryClient.setQueryData(placementKey(`claude`, ``, `claude-code`), { account: `joined-since`, judgedAt: NOW, narrowed: true });
        expect(runServing({ provider: `claude`, harness: `native`, model: `` }).account).toEqual({ id: `joined-since`, byAllowance: true });
    });
});
