import { unstubbed } from "@intentic/testing";
import type { AccountDoor, ProviderModule } from "../agent/providers/provider-module.js";
import type { ProviderDeps } from "../runtimes/runtime-table.js";
import { services } from "../harness/route-services.testing.js";
import { markSpentByHand, observedOwnLimit, unmarkSpentByHand } from "./observed-accounts.js";
import type { ObservedLimit, ObservedLimitStore, ObservedSpend } from "./observed-limits.js";
import { BY_HAND_FOR_MS, OBSERVED_FOR_MS, observedUntil } from "./observed-limits.js";

/* The last resort for a plan that publishes no allowance to read. Cursor's API vends nothing about allowances and
   Devin's quota lives only on its own pages, so until a turn is refused nothing here knows — and a mark set by hand is
   the only way to say so ahead of the first refusal. */

const NOW = 1_700_000_000_000;
const MODEL = `claude-opus-5-5`;

interface Written {
    readonly provider: string;
    readonly account: string;
    readonly model: string;
    readonly limit: ObservedLimit;
}

interface Stand {
    readonly written: Written[];
    readonly forgotten: string[];
    readonly refreshed: string[];
}

// A sandbox with one provider whose accounts are its own (Cursor's shape), its ledger as given, and every write noted.
const stand = (ledger: Record<string, ObservedSpend>, accounts: readonly { readonly id: string; readonly label?: string }[]) => {
    const noted: Stand = { written: [], forgotten: [], refreshed: [] };
    const door = unstubbed<AccountDoor>(`cursorDoor`, {
        list: async () => accounts.map((row) => ({ id: row.id, label: row.label ?? row.id, connectedAt: 0 })),
    });
    const composed = services({
        providerModules: [unstubbed<ProviderModule<ProviderDeps>>(`cursorModule`, { id: "cursor", accounts: () => door })],
        observedLimits: unstubbed<ObservedLimitStore>(`observedLimits`, {
            spent: async (_provider, account) => ledger[account] ?? {},
            record: async (provider, account, model, limit) => void noted.written.push({ provider, account, model, limit }),
            forget: async (_provider, account, model) => {
                noted.forgotten.push(`${account}:${model}`);
                return (ledger[account] ?? {})[model] !== undefined;
            },
        }),
        headroom: { ...services().headroom, refresh: async (options) => void noted.refreshed.push((options?.scope?.providers ?? []).join(`,`)) },
    });
    return { noted, services: composed };
};

test("a hand-set mark lands on every connected account, since a spent subscription is not one sign-in's problem", async () => {
    const { services: composed, noted } = stand({}, [{ id: `one`, label: `work@example.com` }, { id: `two` }]);
    jest.setSystemTime(NOW);

    const outcome = await markSpentByHand(composed, { provider: "cursor", model: MODEL, why: `Cursor says out of usage` });

    expect(outcome.ok).toBe(true);
    expect(noted.written.map((row) => row.account)).toEqual([`one`, `two`]);
    expect(noted.written[0]?.limit).toEqual({ at: NOW, message: `Marked out of allowance by hand: Cursor says out of usage`, byHand: true });
    // The picker and the next spawn listing move within the same beat, rather than at the next sweep.
    expect(noted.refreshed).toEqual([`cursor`]);
    jest.useRealTimers();
});

// A mark nobody sets by accident is worth believing far longer than a turn's own refusal: Cursor's plan resets monthly,
// and a two-hour horizon would re-offer the spent model before lunch.
test("a hand-set mark outlives a refused turn's own record", () => {
    expect(observedUntil({ at: NOW, message: `refused` })).toBe(NOW + OBSERVED_FOR_MS);
    expect(observedUntil({ at: NOW, message: `by hand`, byHand: true })).toBe(NOW + BY_HAND_FOR_MS);
    expect(BY_HAND_FOR_MS).toBeGreaterThan(OBSERVED_FOR_MS);
});

test("unmarking drops that one model and leaves the account's others standing", async () => {
    const { services: composed, noted } = stand({ one: { [MODEL]: { at: NOW, message: `by hand`, byHand: true } } }, [{ id: `one` }]);

    const outcome = await unmarkSpentByHand(composed, { provider: "cursor", model: MODEL });

    expect(outcome).toEqual({ ok: true, message: `cursor/${MODEL} is no longer marked out of allowance on one; it is spendable again.` });
    expect(noted.forgotten).toEqual([`one:${MODEL}`]);
});

test("says so plainly rather than silently doing nothing when there was no mark", async () => {
    const { services: composed } = stand({}, [{ id: `one` }]);

    await expect(unmarkSpentByHand(composed, { provider: "cursor", model: MODEL })).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining(`nothing to unmark`),
    });
});

// A provider that publishes its own allowance reads it directly; a mark here would be ignored and then overwritten, so
// it is refused with the reason rather than written and forgotten.
test("refuses to mark a provider that publishes its own allowance", async () => {
    const { services: composed, noted } = stand({}, [{ id: `one` }]);

    const outcome = await markSpentByHand(composed, { provider: "claude", model: MODEL });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`publishes its own allowance`);
    expect(noted.written).toEqual([]);
});

test("refuses a provider that is not one, naming the ones that are", async () => {
    const { services: composed } = stand({}, []);

    // SAFETY: the point of the case is a provider name that is not in the union, as one arriving off the wire can be.
    await expect(markSpentByHand(composed, { provider: "kurzor" as never, model: MODEL })).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining(`There is no provider "kurzor"`),
    });
});

/* The reader the spawn listing uses: one read of the ledger per provider, not one per model, and no knowledge of any
   particular provider in it. */
describe("what a provider's own ledger says about any model", () => {
    test("calls a model with an entry spent and one without it roomy, from one read", async () => {
        const { services: composed } = stand({ one: { [MODEL]: { at: NOW, message: `out of usage` } } }, [{ id: `one` }]);
        jest.setSystemTime(NOW + 1_000);

        const own = await observedOwnLimit(composed, "cursor");

        expect(await own?.(MODEL)).toMatchObject({ spent: 1, withHeadroom: 0 });
        // Composer is a different pool on the same plan: Cursor's own refusal says to switch to it.
        expect(await own?.(`composer-2.5`)).toMatchObject({ spent: 0, withHeadroom: 1 });
        jest.useRealTimers();
    });

    test("answers for nobody when the provider publishes its own allowance, so the fleet readings keep speaking", async () => {
        const { services: composed } = stand({}, [{ id: `one` }]);

        await expect(observedOwnLimit(composed, "claude")).resolves.toBeUndefined();
    });

    test("answers for nobody with no account connected, which is unmeasured rather than spent", async () => {
        const { services: composed } = stand({}, []);

        await expect(observedOwnLimit(composed, "cursor")).resolves.toBeUndefined();
    });
});
