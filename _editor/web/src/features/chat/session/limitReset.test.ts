import type { LimitResetStatus } from "@intentic/sandbox-contract";
import { beforeEach, expect, it, vi } from "vitest";

// Pins what the strip may ask and how often: once per account, never on a timer, and a failure isn't cached as an
// answer. The daemon's probe rate-limits reads hard enough to cost neighboring meters their freshness.

const answers = vi.fn();
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJsonVia: (...args: unknown[]) => answers(...args) }));

const { askLimitReset, claimLimitReset, limitResetFor, limitResetNote } = await import("./limitReset");

const AVAILABLE: LimitResetStatus = { available: true };

// Fresh account name per test: avoids resetting the module's own dedupe state directly.
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
    await askLimitReset(account);

    expect(answers).toHaveBeenCalledTimes(1);
    expect(answers.mock.calls[0]?.[1]).toBe(`/usage/limit-reset/${account}`);
});

it(`asks the sandbox the conversation is homed in, not the one in front of the user`, async () => {
    const account = fresh();
    answers.mockResolvedValue(AVAILABLE);

    await askLimitReset(account, `sb-elsewhere`);
    expect(limitResetFor(account)).toEqual(AVAILABLE);

    expect(answers.mock.calls[0]?.[0]).toBe(`sb-elsewhere`);
});

it(`leaves a failed ask unanswered, so an unreachable daemon never becomes a durable "no"`, async () => {
    const account = fresh();
    answers.mockRejectedValueOnce(new Error(`unreachable`));

    await askLimitReset(account);
    expect(answers).toHaveBeenCalledTimes(1);
    expect(limitResetFor(account)).toBeUndefined();

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
    expect(limitResetFor(account)).toBeUndefined();

    for (const result of [`already_used`, `ineligible`, `not_limited`]) {
        await offered();
        answers.mockResolvedValue({ result });
        await claimLimitReset(account);
        expect(limitResetFor(account)).toBeUndefined();
    }

    await offered();
    answers.mockRejectedValue(new Error(`unreachable`));
    expect(await claimLimitReset(account)).toMatchObject({ result: `error` });
    expect(limitResetFor(account)).toEqual(AVAILABLE);
});

it(`says which kind of nothing happened, and says nothing at all about a reset that worked`, () => {
    expect(limitResetNote({ result: `reset` })).toBe(``);
    const notes = [`already_used`, `not_limited`, `ineligible`].map((result) => limitResetNote({ result } as never));
    expect(new Set(notes).size).toBe(3);
    expect(notes.every((note) => note !== ``)).toBe(true);
    expect(limitResetNote({ result: `error`, detail: `The provider answered 503.` })).toBe(`The provider answered 503.`);
    expect(limitResetNote({ result: `unavailable` })).toMatch(/try again/i);
    expect(limitResetNote({ result: `ineligible` })).toBe(`Anthropic didn't grant this account a reset. Its current limit still applies.`);
});
