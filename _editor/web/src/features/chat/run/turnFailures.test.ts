import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { computed, ref } from "vue";
import type { PickUp } from "./pickUp";
import type { SessionRef } from "./turnRequest";
import { type FailureHost, TurnFailures } from "./turnFailures";

// A failure host whose turn records what the failure asked of it; nothing here writes a transcript line, so that seam
// names itself if a case reaches for it.
const hostOf = (): FailureHost & { readonly reattach: ReturnType<typeof jest.fn> } => {
    const reattach = jest.fn(async () => false);
    return {
        reattach,
        transcript: unstubbed<FailureHost["transcript"]>(`transcript`, {}),
        selection: unstubbed<FailureHost["selection"]>(`selection`, {}),
        session: ref<SessionRef | undefined>(),
        error: ref<string | null>(null),
        pickUp: ref<PickUp | undefined>(),
        turn: unstubbed<FailureHost["turn"]>(`turn`, { streaming: computed(() => false), reattach }),
    };
};

describe(`a turn that outgrew the model's window`, () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    // The daemon opens the fresh session on its next pass, holding the conversation's queue for it; attach streams are
    // pull, so the window has to go looking for that run once this one's stream is over.
    it(`is a wait this window watches when the daemon re-runs it, not a red line`, async () => {
        const host = hostOf();
        const failures = new TurnFailures(host);
        host.error.value = `an earlier sentence in the same turn`;
        failures.apply({
            kind: `error`,
            code: `context-overflow`,
            message: `Prompt is too long. Resuming…`,
            autoResume: `scheduled`,
            held: { ran: true },
        });

        expect(host.error.value).toBeNull();
        expect(host.pickUp.value).toBeUndefined();
        // Nothing is probed mid-stream: the run it would find is the one still failing.
        await advanceTimersByTimeAsync(10_000);
        expect(host.reattach).toHaveBeenCalledTimes(0);

        failures.armRenewalProbe();
        await advanceTimersByTimeAsync(2_000);
        expect(host.reattach).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(3_000);
        expect(host.reattach).toHaveBeenCalledTimes(2);
        failures.cancelProbe();
    });

    // The fresh session overflowing too is the end of it: nothing is coming back, and nothing here would fix it.
    it(`is the red line when the fresh re-run overflowed as well, with nothing to press and nothing to watch`, async () => {
        const host = hostOf();
        const failures = new TurnFailures(host);
        const sentence = `Prompt is too long. A fresh session could not hold this turn either.`;
        failures.apply({ kind: `error`, code: `context-overflow`, message: sentence });

        expect(host.error.value).toBe(sentence);
        expect(host.pickUp.value).toBeUndefined();
        failures.armRenewalProbe();
        await advanceTimersByTimeAsync(40_000);
        expect(host.reattach).toHaveBeenCalledTimes(0);
    });
});
