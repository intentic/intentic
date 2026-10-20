import { fleetCapacity } from "@intentic/sandbox-contract/models/plan-pools";
import { memoryProviderRefusalStore } from "./provider-refusals.js";
import { markSpentByHand, unmarkSpentByHand } from "./spent-by-hand.js";

/* The last resort for a plan that publishes no allowance to read. Cursor's API vends nothing about allowances and
   Devin's quota lives only on its own pages, so until a turn is refused nothing here knows — and a mark set by hand is
   the only way to say so ahead of the first refusal. It is filed as the refusal a turn would have filed, so every surface
   reads it the way it reads any other (2026-10-13: the mark was a ledger of its own that only the ladder read). */

const MODEL = `claude-opus-5-5`;

// A sandbox with one provider whose accounts are its own (Cursor's shape), over the real ledger held in memory.
const stand = (accounts: readonly { readonly id: string; readonly label?: string }[]) => {
    const providerRefusals = memoryProviderRefusalStore();
    const listed = accounts.map((row) => ({ id: row.id, label: row.label ?? row.id, connectedAt: 0 }));
    return { providerRefusals, providerAccounts: async (provider: string) => (provider === "cursor" ? listed : []) };
};

// What every gate, listing and picker would answer for a model, read off the same ledger.
const capacityOf = async (deps: ReturnType<typeof stand>, model: string) =>
    fleetCapacity(
        (await deps.providerAccounts("cursor")).map((row) => ({ account: row.id })),
        (await deps.providerRefusals.onFile())["cursor"] ?? [],
        { id: model },
    );

test("a hand-set mark lands on every connected account, and every surface then reads the model spent", async () => {
    const deps = stand([{ id: `one`, label: `work@example.com` }, { id: `two` }]);

    const outcome = await markSpentByHand(deps, { provider: "cursor", model: MODEL, why: `Cursor says out of usage` });

    expect(outcome.ok).toBe(true);
    expect((await deps.providerRefusals.onFile())["cursor"]).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ account: `one`, model: MODEL, kind: `limit`, byHand: true, message: `Marked out of allowance by hand: Cursor says out of usage` }),
            expect.objectContaining({ account: `two`, model: MODEL, byHand: true }),
        ]),
    );
    expect((await capacityOf(deps, MODEL)).kind).toBe(`spent`);
    // Composer is a different pool on the same plan: Cursor's own refusal says to switch to it.
    expect((await capacityOf(deps, `composer-2.5`)).kind).toBe(`serving`);
});

test("unmarking drops that one model and leaves the account's others standing", async () => {
    const deps = stand([{ id: `one` }]);
    await markSpentByHand(deps, { provider: "cursor", model: MODEL });
    await markSpentByHand(deps, { provider: "cursor", model: `composer-2.5` });

    const outcome = await unmarkSpentByHand(deps, { provider: "cursor", model: MODEL });

    expect(outcome).toEqual({ ok: true, message: `cursor/${MODEL} is no longer marked out of allowance on one; it is spendable again.` });
    expect((await deps.providerRefusals.onFile())["cursor"]).toMatchObject([{ model: `composer-2.5` }]);
    expect((await capacityOf(deps, MODEL)).kind).toBe(`serving`);
});

test("says so plainly rather than silently doing nothing when there was no mark", async () => {
    const deps = stand([{ id: `one` }]);

    await expect(unmarkSpentByHand(deps, { provider: "cursor", model: MODEL })).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining(`nothing to unmark`),
    });
});

// A provider that publishes its own allowance reads it directly; a mark here would be ignored and then overwritten, so
// it is refused with the reason rather than written and forgotten.
test("refuses to mark a provider that publishes its own allowance", async () => {
    const deps = stand([{ id: `one` }]);

    const outcome = await markSpentByHand(deps, { provider: "claude", model: MODEL });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`publishes its own allowance`);
    expect(await deps.providerRefusals.onFile()).toEqual({});
});

test("refuses a provider that is not one, naming the ones that are", async () => {
    const deps = stand([]);

    // SAFETY: the point of the case is a provider name that is not in the union, as one arriving off the wire can be.
    await expect(markSpentByHand(deps, { provider: "kurzor" as never, model: MODEL })).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining(`There is no provider "kurzor"`),
    });
});

test("refuses a provider with no account connected, which has no allowance to mark", async () => {
    await expect(markSpentByHand(stand([]), { provider: "cursor", model: MODEL })).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining(`No cursor account is connected`),
    });
});
