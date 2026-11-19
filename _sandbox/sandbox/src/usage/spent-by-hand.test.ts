import { fleetCapacity } from "@intentic/sandbox-contract/models/plan-pools";
import { memoryProviderRefusalStore } from "./provider-refusals.js";
import { markSpentByHand, unmarkSpentByHand } from "./spent-by-hand.js";

/* The last resort for a plan that publishes no allowance to read. Cursor's API vends nothing about allowances and
   Devin's quota lives only on its own pages, so until a turn is refused nothing here knows — and a mark set by hand is
   the only way to say so ahead of the first refusal. It is filed as the refusal a turn would have filed, so every surface
   reads it the way it reads any other (2026-10-13: the mark was a ledger of its own that only the ladder read). */

const MODEL = `claude-opus-5-5`;

// A sandbox with one provider whose accounts are its own (Cursor's shape), over the real ledger held in memory.
// Codex's credentials are the translator's, named by auth file.
const stand = (accounts: readonly { readonly id: string; readonly label?: string }[], codex: readonly string[] = []) => {
    const providerRefusals = memoryProviderRefusalStore();
    const listed = accounts.map((row) => ({ id: row.id, label: row.label ?? row.id, connectedAt: 0 }));
    return {
        providerRefusals,
        providerAccounts: async (provider: string) => (provider === "cursor" ? listed : []),
        cliProxy: { accounts: async () => ({ codex: codex.map((name) => ({ name, label: `${name}@example.com` })), grok: [], kimi: [], gemini: [] }) },
    };
};

// What every gate, listing and picker would answer for a model, read off the same ledger.
const capacityOf = async (deps: ReturnType<typeof stand>, model: string) =>
    fleetCapacity(
        (await deps.providerAccounts("cursor")).map((row) => ({ account: row.id })),
        (await deps.providerRefusals.onFile())["cursor"] ?? [],
        { id: model },
        Date.now(),
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

// 2026-11-14: Codex refused GPT 6.1 Sol naming a reset four days out that no window it publishes had, and every Codex
// turn was held at the door while both windows read mostly free. Only an answered turn could take it back, and every
// turn was held, so a provider that publishes its own allowance can have its refusal taken back by hand too. The next
// turn then asks the provider, and is refused again if it is still spent.
test("takes back the provider's own refusal for a provider that publishes its allowance, on the translator's credential", async () => {
    const deps = stand([], [`codex-a.json`, `codex-b.json`]);
    const resetsAt = Math.floor(Date.now() / 1000) + 4 * 86_400;
    const said = { at: Date.now() - 60_000, kind: `limit`, model: `gpt-6.1-sol`, resetsAt, message: `The usage limit has been reached` } as const;
    await deps.providerRefusals.record(`codex`, { ...said, account: `codex-a.json` });
    await deps.providerRefusals.record(`codex`, { ...said, account: `codex-b.json` });
    await deps.providerRefusals.record(`codex`, { ...said, account: `codex-a.json`, model: `gpt-6-luna` });

    const outcome = await unmarkSpentByHand(deps, { provider: "codex", model: `gpt-6.1-sol`, account: `codex-a.json` });

    expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining(`refusal on codex-a.json@example.com is taken back`) });
    expect((await deps.providerRefusals.onFile())["codex"]).toEqual(
        expect.arrayContaining([expect.objectContaining({ account: `codex-b.json`, model: `gpt-6.1-sol` }), expect.objectContaining({ account: `codex-a.json`, model: `gpt-6-luna` })]),
    );
    expect((await deps.providerRefusals.onFile())["codex"]).toHaveLength(2);
    // Named by no account, it takes back every credential's, and a routed refusal that named none.
    await deps.providerRefusals.record(`codex`, said);
    await unmarkSpentByHand(deps, { provider: "codex", model: `gpt-6.1-sol` });
    expect((await deps.providerRefusals.onFile())["codex"]).toMatchObject([{ model: `gpt-6-luna` }]);
    // Marking one by hand is still refused: the provider's own reading would overwrite it.
    await expect(markSpentByHand(deps, { provider: "codex", model: `gpt-6.1-sol` })).resolves.toMatchObject({ ok: false });
});
