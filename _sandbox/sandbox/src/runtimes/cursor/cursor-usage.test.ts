import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";
import type { CursorStore, StoredCursorAccount } from "./accounts/cursor-credentials.js";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { type CursorPlacementDeps, cursorAccountForTurn } from "./cursor-usage.js";

/* Cursor publishes no allowance, so which account a turn lands on comes from what it has already refused, filed in the
   one refusal ledger. What this suite pins is that a refusal stays about the one account and the one model it was given
   for. */

const NOW = 1_700_000_000_000;
const REFUSED = `429 You've hit your usage limit.`;
const COMPOSER = `composer-2.5`;

const account = (id: string, over: Partial<StoredCursorAccount> = {}): StoredCursorAccount => ({ id, apiKey: `key-${id}`, connectedAt: 0, ...over });
const outOf = (id: string, model: string = COMPOSER): ProviderRefusal => ({ at: Date.now(), kind: `limit`, message: REFUSED, account: id, model });

type OnFile = ProviderRefusalStore["onFile"];
// The accounts as Cursor's door lists them for the verdicts (serviceability.ts accountFactsOf) and as its store holds
// them for the turn; nothing else is read for a Cursor pick.
const deps = (
    accounts: readonly StoredCursorAccount[],
    refusals: readonly ProviderRefusal[] = [],
    onFile: OnFile = async () => ({ cursor: refusals }),
    flapping: readonly string[] = [],
): CursorPlacementDeps =>
    unstubbed<CursorPlacementDeps>(`services`, {
        cursorStore: unstubbed<CursorStore>(`cursorStore`, { credentials: async () => [...accounts] }),
        providerRefusals: unstubbed<ProviderRefusalStore>(`providerRefusals`, { onFile, flapping: async () => new Set(flapping) }),
        providerAccounts: async (provider) => (provider === `cursor` ? accounts.map(({ id }): OauthAccount => ({ id, label: id, connectedAt: 0 })) : []),
        logger: pino({ level: `silent` }),
    });

test("a named account is honoured, because that choice is the user's", async () => {
    expect((await cursorAccountForTurn(deps([account(`one`), account(`two`)], [outOf(`two`)]), `two`, COMPOSER))?.id).toBe(`two`);
});

test("a named account that has expired is nobody, not the next row along", async () => {
    jest.setSystemTime(NOW);
    expect(await cursorAccountForTurn(deps([account(`live`), account(`dead`, { apiKeyExpiresAtMs: NOW - 1 })]), `dead`, COMPOSER)).toBeUndefined();
    jest.useRealTimers();
});

// The fix for the helper that kept landing on the spent account: the model decides which credential serves.
test("an unnamed turn lands on the account that still has the model asked for", async () => {
    expect((await cursorAccountForTurn(deps([account(`one`), account(`two`)], [outOf(`one`)]), undefined, COMPOSER))?.id).toBe(`two`);
});

test("a model the spent account was never refused for still runs on it, first-connected as ever", async () => {
    expect((await cursorAccountForTurn(deps([account(`one`), account(`two`)], [outOf(`one`)]), undefined, `claude-opus-5`))?.id).toBe(`one`);
});

// 2026-10-17: a Cursor account refusing `[role_forbidden]` took two children in a row. Refused outright, it comes after
// every account that is only out of one model.
test("an account refused outright comes after one that is only out of the model", async () => {
    const forbidden: ProviderRefusal = { at: Date.now(), kind: `entitlement`, message: `[role_forbidden]`, account: `one` };
    expect((await cursorAccountForTurn(deps([account(`one`), account(`two`)], [forbidden, outOf(`two`)]), undefined, COMPOSER))?.id).toBe(`two`);
});

test("one connected account is not a choice, and no refusal is read to make it", async () => {
    const onFile = jest.fn<OnFile>(async () => ({}));
    expect((await cursorAccountForTurn(deps([account(`only`)], [], onFile), undefined, COMPOSER))?.id).toBe(`only`);
    expect(onFile).not.toHaveBeenCalled();
});

test("an unnamed turn ranks an account its organisation keeps switching off behind a steady one, as every window does", async () => {
    expect((await cursorAccountForTurn(deps([account(`flaps`), account(`steady`)], [], undefined, [`flaps`]), undefined, COMPOSER))?.id).toBe(`steady`);
});
