import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { CapacityAccount, ProviderCapacity } from "@intentic/sandbox-contract/schemas/providers/capacity";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import {
    capacityReconnected,
    providerAccounts,
    providerCapacities,
    providerRefusals,
    providerSwitchOffs,
    setCapacitySnapshot,
    setProviderCapacity,
    usageByAccount,
} from "../providerAccounts";
import { capacityMismatches, checkCapacityParity } from "./doorFacts";
import { accountFacts, accountState, capacityOf, degradedOf, flappingOf, liveUsage, modelCapacity } from "../usageStatus";
import { degradedNote } from "./degradedNote";

// The verdict door reads a provider from the capacity the daemon judged whenever this window holds one, and from the
// account lists, readings and refusals it would otherwise assemble against a daemon from before it. The store keeps the
// newest capacity per provider; the door judges whichever source it holds by the one rule at the sandbox's clock.

// A reading a minute old whose one weekly pool has no published reset: current for its whole week.
const reading = (utilization: number): AccountUsage => ({
    measuredAt: Date.now() - 60_000,
    windows: [{ kind: `seven_day`, utilization, gates: `all` }],
});
const row = (id: string, utilization: number): OauthAccount => ({ id, label: id, connectedAt: 0, usage: reading(utilization) });
// One account of a capacity: its facts, and the verdict the daemon reached on them.
const judged = (account: string, utilization: number, state: CapacityAccount["state"]): CapacityAccount => ({
    account,
    label: account,
    usage: reading(utilization),
    state,
});
const READY: CapacityAccount["state"] = { kind: `ready`, room: 80 };
const capacity = (over: Partial<ProviderCapacity> = {}): ProviderCapacity => ({
    provider: `claude`,
    seq: 1,
    judgedAt: Date.now(),
    accounts: [],
    refusals: [],
    ...over,
});

beforeEach(() => {
    // An answer naming no provider drops everything held and every carried-over mark with it.
    setCapacitySnapshot({ providers: [] });
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
    providerRefusals.value = {};
    providerSwitchOffs.value = {};
    usageByAccount.value = {};
});

describe(`the store`, () => {
    it(`keeps the capacity with the highest seq for a provider, whichever arrives first`, () => {
        setProviderCapacity(capacity({ seq: 5, placement: `five` }));
        setProviderCapacity(capacity({ seq: 3, placement: `three` }));
        expect(providerCapacities.value[`claude`]?.placement).toBe(`five`);

        setProviderCapacity(capacity({ seq: 7, placement: `seven` }));
        expect(providerCapacities.value[`claude`]?.placement).toBe(`seven`);
    });

    // A restarted daemon numbers its capacities from one again: refused by number, the window would draw the old process's
    // picture until the new one counted past it.
    it(`takes the first capacity a new connection hears, whatever its number`, () => {
        setProviderCapacity(capacity({ seq: 40, placement: `before` }));
        capacityReconnected(true);
        expect(providerCapacities.value[`claude`]?.placement).toBe(`before`);

        setProviderCapacity(capacity({ seq: 1, placement: `after` }));
        setProviderCapacity(capacity({ seq: 0, placement: `stale` }));
        expect(providerCapacities.value[`claude`]?.placement).toBe(`after`);
    });

    it(`lets go of everything once a reconnected daemon judges no capacity, so the door reads the stores again`, () => {
        setProviderCapacity(capacity({ seq: 2 }));
        capacityReconnected(false);
        expect(providerCapacities.value).toEqual({});
    });

    it(`drops, on a whole answer, a provider it leaves out, unless a frame newer than the answer holds it`, () => {
        setProviderCapacity(capacity({ provider: `codex`, seq: 3 }));
        setProviderCapacity(capacity({ provider: `claude`, seq: 12, placement: `frame` }));

        setCapacitySnapshot({ providers: [capacity({ provider: `claude`, seq: 9, placement: `answer` }), capacity({ provider: `gemini`, seq: 8 })] });

        expect(Object.keys(providerCapacities.value).toSorted()).toEqual([`claude`, `gemini`]);
        expect(providerCapacities.value[`claude`]?.placement).toBe(`frame`);
    });
});

describe(`the door`, () => {
    it(`judges an account on the facts the daemon judged, over the row and reading the stores hold for it`, () => {
        const spentRow = row(`a`, 100);
        providerAccounts.value = { ...providerAccounts.value, claude: [spentRow] };
        expect(accountState(`claude`, accountFacts(spentRow)).kind).toBe(`spent`);

        setProviderCapacity(capacity({ accounts: [judged(`a`, 20, READY)] }));
        expect(accountState(`claude`, accountFacts(spentRow))).toEqual({ kind: `ready`, room: 80 });
        expect(liveUsage(`claude`, `a`, spentRow.usage)?.windows[0]?.utilization).toBe(20);
    });

    it(`reads the refusals on file off the capacity, not off the refusals feed`, () => {
        const refusal: ProviderRefusal = { at: Date.now() - 1_000, kind: `auth`, message: `401 token revoked`, account: `a` };
        providerAccounts.value = { ...providerAccounts.value, claude: [row(`a`, 20)] };
        setProviderCapacity(capacity({ accounts: [judged(`a`, 20, READY)], refusals: [refusal] }));

        expect(accountState(`claude`, accountFacts(row(`a`, 20)))).toEqual({ kind: `blocked`, fix: `reconnect`, reason: `401 token revoked` });
        expect(modelCapacity(`claude`, undefined)).toMatchObject({ kind: `spent`, accounts: 1 });
    });

    it(`judges an account no capacity has heard of yet on the row its caller holds, beside the judged ones`, () => {
        setProviderCapacity(capacity({ accounts: [judged(`a`, 100, { kind: `spent` })] }));

        expect(accountState(`claude`, accountFacts(row(`fresh`, 10)))).toEqual({ kind: `ready`, room: 90 });
    });

    it(`reads the stores against a daemon that sends no capacity`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [row(`a`, 30)] };
        usageByAccount.value = { "claude:a": reading(100) };

        expect(capacityOf(`claude`)).toBeUndefined();
        expect(accountState(`claude`, accountFacts(row(`a`, 30))).kind).toBe(`spent`);
    });

    it(`ranks by the switch-offs the capacity carries, and says when the provider itself is failing`, () => {
        const now = Date.now();
        providerSwitchOffs.value = { claude: { b: [now - 2 * 86_400_000, now - 86_400_000] } };
        setProviderCapacity(
            capacity({
                accounts: [judged(`a`, 10, READY)],
                switchOffs: { a: [now - 3 * 86_400_000, now - 86_400_000] },
                degraded: { cause: `outage`, retryAt: now + 300_000, attempt: 2 },
            }),
        );

        expect([...flappingOf(`claude`)]).toEqual([`a`]);
        expect(degradedOf(`claude`)).toEqual({ cause: `outage`, retryAt: now + 300_000, attempt: 2 });
    });
});

// In a development build each account's verdict is judged again from the stores at the capacity's own instant, and a
// disagreement is warned once: a fact one side reads and the other does not.
describe(`the parity check`, () => {
    it(`names the account the capacity and the stores judge differently, with both verdicts`, () => {
        providerAccounts.value = { ...providerAccounts.value, claude: [row(`a`, 100), row(`b`, 30)] };
        const held = capacity({ accounts: [judged(`a`, 20, READY), judged(`b`, 30, { kind: `ready`, room: 70 })] });

        expect(capacityMismatches(held)).toEqual([{ provider: `claude`, account: `a`, judged: READY, assembled: expect.objectContaining({ kind: `spent` }) }]);
    });

    it(`warns each disagreement once, however many capacities repeat it`, () => {
        const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
        providerAccounts.value = { ...providerAccounts.value, claude: [row(`parity`, 100)] };
        const held = capacity({ accounts: [judged(`parity`, 20, READY)] });

        checkCapacityParity(held);
        checkCapacityParity({ ...held, seq: 2 });

        expect(warn.mock.calls.filter(([message]) => String(message).startsWith(`capacity parity:`))).toEqual([
            [`capacity parity: claude account parity is judged differently`, { daemon: READY, window: expect.objectContaining({ kind: `spent` }) }],
        ]);
        warn.mockRestore();
    });

    it(`has nothing to compare where the stores hold no account of the provider`, () => {
        expect(capacityMismatches(capacity({ accounts: [judged(`a`, 20, READY)] }))).toEqual([]);
    });
});

describe(`a provider the daemon reports degraded`, () => {
    it(`is said with its cause and when the sandbox tries it again`, () => {
        setProviderCapacity(capacity({ degraded: { cause: `outage`, retryAt: Date.now() + 300_000 } }));
        expect(degradedNote(`claude`)).toEqual({
            short: `Down`,
            title: `Claude Code is failing requests`,
            retry: `The sandbox tries it again in about 5 min`,
            line: `Claude Code is failing requests · The sandbox tries it again in about 5 min`,
        });

        setProviderCapacity(capacity({ seq: 2, degraded: { cause: `throttle`, retryAt: Date.now() - 1_000 } }));
        expect(degradedNote(`claude`)).toEqual({
            short: `Throttling`,
            title: `Claude Code is turning requests away for now`,
            retry: undefined,
            line: `Claude Code is turning requests away for now`,
        });
    });

    it(`is not said of a provider the daemon reports nothing about`, () => {
        setProviderCapacity(capacity());
        expect(degradedNote(`claude`)).toBeUndefined();
        expect(degradedNote(`codex`)).toBeUndefined();
    });
});
