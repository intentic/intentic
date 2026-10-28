import "@intentic/testing/dom";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { providerAccounts } from "../../providers/providerAccounts";
import { Conversation } from "../session/conversation";
import { runSpentUntil, spentUntilOf } from "./runServing";

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
