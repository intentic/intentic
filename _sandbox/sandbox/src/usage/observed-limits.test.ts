import { test, expect } from "bun:test";
import { observedTurnLimit, type ObservedSpend, observedUsage, pickObservedAccount } from "./observed-limits.js";

/* A refusal is the only measurement some plans give, so what this suite pins is that it is read as narrowly as it was
   given: about one account, about one model, and never as a claim about when anything reopens. */

const NOW = 1_700_000_000_000;
const COMPOSER = { id: `composer-2.5` };
const OPUS = { id: `claude-opus-5` };

const spent = (...models: readonly string[]): ObservedSpend =>
    Object.fromEntries(models.map((model, index) => [model, { at: NOW - index * 1000, message: `429 usage limit reached` }]));

const labels = (model: string): string | undefined => (model === `composer-2.5` ? `Composer 2.5` : undefined);

test("a refusal becomes a full pool that gates only the model it named", () => {
    const usage = observedUsage(spent(`composer-2.5`), labels, NOW);

    expect(usage).toEqual({
        windows: [{ kind: `observed:composer-2.5`, label: `Composer 2.5`, utilization: 100, gates: { models: [`composer-2.5`] } }],
        measuredAt: NOW,
    });
});

// The instant is the whole point: the vendor published none, and a guessed one dates a sentence someone acts on.
test("a reading names no reopening, because nothing published one", () => {
    const window = observedUsage(spent(`composer-2.5`), undefined, NOW)?.windows[0];

    expect(window?.resetsAt).toBeUndefined();
    expect(window?.label).toBe(`Composer 2.5`);
});

test("an account with nothing on file has no reading at all, which is not a reading of zero", () => {
    expect(observedUsage({}, labels, NOW)).toBeUndefined();
});

test("an account refused one model still has room for another", () => {
    const readings = [{ account: `a`, spent: spent(`composer-2.5`) }];

    expect(observedTurnLimit(readings, COMPOSER, labels, NOW)).toEqual({ pool: `Composer 2.5`, spent: 1, withHeadroom: 0 });
    expect(observedTurnLimit(readings, OPUS, labels, NOW)).toEqual({ spent: 0, withHeadroom: 1, roomMeasuredAt: NOW });
});

// The whole fix: one account's spent model must not read as the fleet's, or a chain benches a rung it could still run.
test("a sibling with nothing on file is headroom, measured now, so a benched rung can be asked again", () => {
    const limit = observedTurnLimit(
        [
            { account: `a`, spent: spent(`composer-2.5`) },
            { account: `b`, spent: {} },
        ],
        COMPOSER,
        labels,
        NOW,
    );

    expect(limit).toEqual({ pool: `Composer 2.5`, spent: 1, withHeadroom: 1, roomMeasuredAt: NOW });
});

test("every account refused leaves no headroom and still no instant to wait for", () => {
    const limit = observedTurnLimit(
        [
            { account: `a`, spent: spent(`composer-2.5`) },
            { account: `b`, spent: spent(`composer-2.5`) },
        ],
        COMPOSER,
        labels,
        NOW,
    );

    expect(limit).toEqual({ pool: `Composer 2.5`, spent: 2, withHeadroom: 0 });
});

test("the account that still has the model serves, whichever order the fleet is in", () => {
    const out = { account: `a`, spent: spent(`composer-2.5`) };
    const open = { account: `b`, spent: spent(`claude-opus-5`) };

    expect(pickObservedAccount([out, open], COMPOSER)?.account).toBe(`b`);
    expect(pickObservedAccount([open, out], COMPOSER)?.account).toBe(`b`);
});

test("a fleet with nothing on file runs where it always did", () => {
    expect(
        pickObservedAccount(
            [
                { account: `a`, spent: {} },
                { account: `b`, spent: {} },
            ],
            COMPOSER,
        )?.account,
    ).toBe(`a`);
});

// Refused longest ago is the one likeliest to have reopened; it also stops a fleet hammering one row.
test("with every account out of the model, the one refused longest ago is tried", () => {
    const fresh = { account: `a`, spent: { "composer-2.5": { at: NOW, message: `429` } } };
    const stale = { account: `b`, spent: { "composer-2.5": { at: NOW - 60_000, message: `429` } } };

    expect(pickObservedAccount([fresh, stale], COMPOSER)?.account).toBe(`b`);
});
