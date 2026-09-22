import { unstubbed } from "@intentic/testing";
import { test, expect, mock, jest } from "bun:test";
import type { ObservedLimitStore, ObservedSpend } from "../../usage/observed-limits.js";
import type { CursorCatalog } from "./cursor-catalog.js";
import type { CursorStore, StoredCursorAccount } from "./cursor-credentials.js";
import { cursorAccountForTurn, cursorHeadroomSource, cursorTurnLimit } from "./cursor-usage.js";

/* Cursor publishes no allowance, so every answer here comes from what it has already refused. What this suite pins is
   that a refusal stays about the one account and the one model it was given for. */

const NOW = 1_700_000_000_000;
const REFUSED = `429 You've hit your usage limit.`;
const COMPOSER = `composer-2.5`;

const account = (id: string, over: Partial<StoredCursorAccount> = {}): StoredCursorAccount => ({ id, apiKey: `key-${id}`, connectedAt: 0, ...over });

const deps = (accounts: readonly StoredCursorAccount[], ledger: Record<string, ObservedSpend> = {}, listed = mock()) => {
    const models = mock(async () => {
        listed();
        return { models: [{ id: COMPOSER, label: `Composer 2.5` }], default: COMPOSER };
    });
    return {
        models,
        deps: {
            cursorStore: unstubbed<CursorStore>(`cursorStore`, { credentials: async () => [...accounts] }),
            cursorModels: unstubbed<CursorCatalog>(`cursorModels`, { models }),
            observedLimits: unstubbed<ObservedLimitStore>(`observedLimits`, { spent: async (_provider, id) => ledger[id] ?? {} }),
        },
    };
};

const outOf = (...models: readonly string[]): ObservedSpend => Object.fromEntries(models.map((model) => [model, { at: NOW, message: REFUSED }]));

test("a named account is honoured, because that choice is the user's", async () => {
    const { deps: services } = deps([account(`one`), account(`two`)], { two: outOf(COMPOSER) });

    expect((await cursorAccountForTurn(services, `two`, COMPOSER))?.id).toBe(`two`);
});

test("a named account that has expired is nobody, not the next row along", async () => {
    const { deps: services } = deps([account(`live`), account(`dead`, { apiKeyExpiresAtMs: NOW - 1 })]);
    jest.setSystemTime(NOW);

    expect(await cursorAccountForTurn(services, `dead`, COMPOSER)).toBeUndefined();
    jest.useRealTimers();
});

// The fix for the helper that kept landing on the spent account: the model decides which credential serves.
test("an unnamed turn lands on the account that still has the model asked for", async () => {
    const { deps: services } = deps([account(`one`), account(`two`)], { one: outOf(COMPOSER) });

    expect((await cursorAccountForTurn(services, undefined, COMPOSER))?.id).toBe(`two`);
});

test("a model the spent account was never refused for still runs on it, first-connected as ever", async () => {
    const { deps: services } = deps([account(`one`), account(`two`)], { one: outOf(COMPOSER) });

    expect((await cursorAccountForTurn(services, undefined, `claude-opus-5`))?.id).toBe(`one`);
});

test("one connected account is not a choice, and no ledger is read to make it", async () => {
    const spent = mock();
    const services = {
        cursorStore: unstubbed<CursorStore>(`cursorStore`, { credentials: async () => [account(`only`)] }),
        cursorModels: unstubbed<CursorCatalog>(`cursorModels`, {}),
        observedLimits: unstubbed<ObservedLimitStore>(`observedLimits`, { spent }),
    };

    expect((await cursorAccountForTurn(services, undefined, COMPOSER))?.id).toBe(`only`);
    expect(spent).not.toHaveBeenCalled();
});

test("a fleet with one account left for the model reads as having headroom, so the ladder asks it", async () => {
    const { deps: services } = deps([account(`one`), account(`two`)], { one: outOf(COMPOSER) });

    const limit = await cursorTurnLimit(services, COMPOSER);
    expect(limit?.spent).toBe(1);
    expect(limit?.withHeadroom).toBe(1);
    expect(limit?.pool).toBe(`Composer 2.5`);
});

test("a fleet entirely out of the model leaves no headroom and no instant to wait for", async () => {
    const { deps: services } = deps([account(`one`), account(`two`)], { one: outOf(COMPOSER), two: outOf(COMPOSER) });

    expect(await cursorTurnLimit(services, COMPOSER)).toEqual({ pool: `Composer 2.5`, spent: 2, withHeadroom: 0 });
});

test("no connected account means no reading, which is not a fleet with no room", async () => {
    const { deps: services } = deps([]);

    expect(await cursorTurnLimit(services, COMPOSER)).toBeUndefined();
});

test("a source target answers with the pools it has, and says outright when it has none", async () => {
    const { deps: services } = deps([account(`one`), account(`two`)], { one: outOf(COMPOSER) });
    const targets = await cursorHeadroomSource(services).targets();

    expect(targets.map((target) => target.key)).toEqual([`one`, `two`]);
    await expect(targets[0]!.read()).resolves.toEqual({
        windows: [{ kind: `observed:${COMPOSER}`, label: `Composer 2.5`, utilization: 100, gates: { models: [COMPOSER] } }],
    });
    // `empty`, not a bare empty list: that is what lets a reading someone was shown be taken back once it ages out.
    await expect(targets[1]!.read()).resolves.toEqual({ windows: [], empty: true });
});

// Every sweep of every provider reaches this target, and almost every one finds nothing on file.
test("an account with nothing on file costs no catalog read", async () => {
    const listed = mock();
    const { deps: services } = deps([account(`one`)], {}, listed);
    const targets = await cursorHeadroomSource(services).targets();
    await targets[0]!.read();

    expect(listed).not.toHaveBeenCalled();
});
