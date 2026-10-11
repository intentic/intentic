import type { HostedPlanState } from "@intentic/api-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { BROWSER_WAIT_MS, dropStripeErrand, planMark, POLL_EVERY_MS, waitForStripe } from "./stripeErrand";

// The wait for an errand in the reader's own browser: over when the plan's answer moves, when the reader drops it, or
// when the browser wait runs out, and never on a read that failed.

const state = (onPlan: boolean): HostedPlanState => ({ enabled: true, onPlan, priceUsd: 20 }) as HostedPlanState;

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(() => {
    dropStripeErrand();
    jest.useRealTimers();
});

test(`the wait ends once the plan's answer differs from what it was when the errand left`, async () => {
    const answers = [state(false), state(false), state(true)];
    const read = jest.fn(async () => answers.shift() ?? state(true));
    const waited = waitForStripe(planMark(state(false)), read);
    await advanceTimersByTimeAsync(POLL_EVERY_MS * 3);
    await expect(waited).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
});

test(`a read that fails is not yet, and the next tick asks again`, async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error(`offline`)).mockResolvedValue(state(true));
    const waited = waitForStripe(planMark(state(false)), read);
    await advanceTimersByTimeAsync(POLL_EVERY_MS * 2);
    await expect(waited).resolves.toBe(true);
});

test(`the reader dropping the errand ends the wait without an answer`, async () => {
    const waited = waitForStripe(planMark(state(false)), async () => state(false));
    await advanceTimersByTimeAsync(POLL_EVERY_MS);
    dropStripeErrand();
    await expect(waited).resolves.toBe(false);
});

test(`a second errand ends the first`, async () => {
    const first = waitForStripe(planMark(state(false)), async () => state(false));
    const second = waitForStripe(planMark(state(false)), async () => state(true));
    await expect(first).resolves.toBe(false);
    await advanceTimersByTimeAsync(POLL_EVERY_MS);
    await expect(second).resolves.toBe(true);
});

test(`the wait gives up once the browser has had its ten minutes`, async () => {
    const waited = waitForStripe(planMark(state(false)), async () => state(false));
    await advanceTimersByTimeAsync(BROWSER_WAIT_MS + POLL_EVERY_MS * 2);
    await expect(waited).resolves.toBe(false);
});
