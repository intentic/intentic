import "@intentic/testing/dom";
import { handoffSpent, markHandoffSpent, mintsOnArrival } from "./handoffSpent";

// A finished hand-off is remembered by its nonce for as long as a browser plausibly restores a tab, then forgotten.

beforeEach(() => localStorage.clear());

const DAY = 24 * 60 * 60 * 1000;

it(`remembers a finished hand-off by its nonce, and only that one`, () => {
    markHandoffSpent(`nonce-1`, 1_000);

    expect({ same: handoffSpent(`nonce-1`, 2_000), other: handoffSpent(`nonce-2`, 2_000) }).toEqual({ same: true, other: false });
});

it(`forgets it after a week`, () => {
    markHandoffSpent(`nonce-1`, 1_000);

    expect({ sixDays: handoffSpent(`nonce-1`, 1_000 + 6 * DAY), eightDays: handoffSpent(`nonce-1`, 1_000 + 8 * DAY) }).toEqual({
        sixDays: true,
        eightDays: false,
    });
});

it(`keeps the twenty most recent`, () => {
    for (let index = 0; index < 21; index += 1) {
        markHandoffSpent(`nonce-${index}`, 1_000 + index);
    }

    expect({ oldest: handoffSpent(`nonce-0`, 2_000), newest: handoffSpent(`nonce-20`, 2_000) }).toEqual({ oldest: false, newest: true });
});

// H4c: a restored hand-off tab said it was done, yet the router's head start still began a Google sign-in it would
// never use. The app's own hand-off starts one; a finished one, or a link without the app's nonce, does not.
it(`starts Google's sign-in on arrival only for the app's own hand-off, and never for one already finished`, () => {
    const handoff = { state: `nonce-1`, challenge: `c-1` };

    expect(mintsOnArrival(handoff, 1_000)).toBe(true);
    expect(mintsOnArrival({ state: `nonce-1` }, 1_000)).toBe(false);
    expect(mintsOnArrival({ state: [`nonce-1`], challenge: `c-1` }, 1_000)).toBe(false);

    markHandoffSpent(`nonce-1`, 1_000);

    expect(mintsOnArrival(handoff, 2_000)).toBe(false);
    expect(mintsOnArrival({ state: `nonce-2`, challenge: `c-2` }, 2_000)).toBe(true);
});
