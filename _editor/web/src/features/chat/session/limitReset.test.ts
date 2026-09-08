import type { LimitResetStatus } from "@intentic/sandbox-contract";
import { beforeEach, expect, it, vi } from "vitest";

/* WHAT THE STRIP IS ALLOWED TO ASK, AND HOW OFTEN, which is the whole of this module's judgement.
 *
 * The daemon's probe tells Anthropic the account is at the wall, and the endpoint behind it rate limits reads
 * hard enough to cost the plan-limit meters next door their freshness. So "asked once per account, never on a
 * timer, and a failure is not an answer" is not tidiness, it is the reason a button can exist here at all, and
 * each of those three is a test below. */

const answers = vi.fn();
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJsonVia: (...args: unknown[]) => answers(...args) }));

const { askLimitReset, claimLimitReset, limitResetFor, limitResetNote } = await import("./limitReset");

const AVAILABLE: LimitResetStatus = { available: true };

// The composable dedupes against its own module state, so each case starts from an account nobody has asked
// about rather than resetting a store this module deliberately does not expose.
let next = 0;
const fresh = (): string => `account-${++next}`;

beforeEach(() => {
    answers.mockReset();
});

it(`asks once per account however many strips want the answer, and shares it`, async () => {
    const account = fresh();
    answers.mockResolvedValue(AVAILABLE);

    await Promise.all([askLimitReset(account), askLimitReset(account)]);
    expect(limitResetFor(account)).toEqual(AVAILABLE);
    // A third ask after the answer landed is still not a second request: the answer is only worth anything
    // while this refusal is on screen, and re-asking is a fresh at-the-wall claim to the provider.
    await askLimitReset(account);

    expect(answers).toHaveBeenCalledTimes(1);
    expect(answers.mock.calls[0]?.[1]).toBe(`/usage/limit-reset/${account}`);
});

it(`asks the sandbox the conversation is homed in, not the one in front of the user`, async () => {
    const account = fresh();
    answers.mockResolvedValue(AVAILABLE);

    await askLimitReset(account, `sb-elsewhere`);
    expect(limitResetFor(account)).toEqual(AVAILABLE);

    // The accounts live on that box: asking the active daemon about one it does not hold would answer "no
    // grant" about a perfectly eligible connection.
    expect(answers.mock.calls[0]?.[0]).toBe(`sb-elsewhere`);
});

it(`leaves a failed ask unanswered, so an unreachable daemon never becomes a durable "no"`, async () => {
    const account = fresh();
    answers.mockRejectedValueOnce(new Error(`unreachable`));

    await askLimitReset(account);
    expect(answers).toHaveBeenCalledTimes(1);
    expect(limitResetFor(account)).toBeUndefined();

    // And the next strip tries again rather than joining the dead request.
    answers.mockResolvedValue(AVAILABLE);
    await askLimitReset(account);
    expect(limitResetFor(account)).toEqual(AVAILABLE);
    expect(answers).toHaveBeenCalledTimes(2);
});

it(`retires the offer on an answer about the account, and keeps it when the claim never landed`, async () => {
    const account = fresh();
    const offered = async (): Promise<void> => {
        answers.mockResolvedValue(AVAILABLE);
        await askLimitReset(account);
        expect(limitResetFor(account)).toEqual(AVAILABLE);
    };

    await offered();
    answers.mockResolvedValue({ result: `reset` });
    expect(await claimLimitReset(account)).toEqual({ result: `reset` });
    // The week's grant is spent, so the button must not survive its own success.
    expect(limitResetFor(account)).toBeUndefined();

    // The provider's other answers are about the account too: whatever they say, "available" was wrong.
    for (const result of [`already_used`, `ineligible`, `not_limited`]) {
        await offered();
        answers.mockResolvedValue({ result });
        await claimLimitReset(account);
        expect(limitResetFor(account)).toBeUndefined();
    }

    // A claim that never reached the daemon spent nothing and proved nothing, so the offer stands and the
    // press stays available: an error that removes the only way to retry it is the worse mistake.
    await offered();
    answers.mockRejectedValue(new Error(`unreachable`));
    expect(await claimLimitReset(account)).toMatchObject({ result: `error` });
    expect(limitResetFor(account)).toEqual(AVAILABLE);
});

it(`says which kind of nothing happened, and says nothing at all about a reset that worked`, () => {
    // `reset` has no line because the window is open and the turn is already going again.
    expect(limitResetNote({ result: `reset` })).toBe(``);
    // The three the provider distinguishes stay distinguished: they send the reader to three different places
    // (next week, the Continue button, their plan).
    const notes = [`already_used`, `not_limited`, `ineligible`].map((result) => limitResetNote({ result } as never));
    expect(new Set(notes).size).toBe(3);
    expect(notes.every((note) => note !== ``)).toBe(true);
    // A transient failure carries the daemon's own sentence when it has one, and a retryable fallback when not.
    expect(limitResetNote({ result: `error`, detail: `The provider answered 503.` })).toBe(`The provider answered 503.`);
    expect(limitResetNote({ result: `unavailable` })).toMatch(/try again/i);
    expect(limitResetNote({ result: `ineligible` })).toBe(`Anthropic didn't grant this account a reset. Its current limit still applies.`);
});
