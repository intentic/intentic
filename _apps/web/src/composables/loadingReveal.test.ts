import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, type Ref } from "vue";
import { useLoadingReveal } from "./loadingReveal";

// The two thresholds are the whole point of the composable, so they are what this suite pins: nothing is drawn
// for a wait that resolves inside the delay, and anything drawn stays long enough to be seen.
describe(`useLoadingReveal`, () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // In a scope, as it is in a component — the composable registers its timer cleanup there.
    const reveal = (loading: Ref<boolean>, subject: Ref<string>): Ref<boolean> =>
        effectScope().run(() => useLoadingReveal(loading, subject)) as Ref<boolean>;

    it(`never reveals a wait that resolves inside the delay`, async () => {
        const loading = ref(true);
        const subject = ref(`chat-1`);
        const revealed = reveal(loading, subject);

        vi.advanceTimersByTime(150);
        loading.value = false;
        await nextTick();
        vi.advanceTimersByTime(5_000);
        expect(revealed.value).toBe(false);
    });

    it(`reveals a wait that outlasts the delay, and holds it against a flicker`, async () => {
        const loading = ref(true);
        const subject = ref(`chat-1`);
        const revealed = reveal(loading, subject);

        vi.advanceTimersByTime(200);
        expect(revealed.value).toBe(true);

        // Answered one tick after it appeared — the hold keeps it on screen rather than strobing it off.
        vi.advanceTimersByTime(50);
        loading.value = false;
        await nextTick();
        expect(revealed.value).toBe(true);
        vi.advanceTimersByTime(349);
        expect(revealed.value).toBe(true);
        vi.advanceTimersByTime(1);
        expect(revealed.value).toBe(false);
    });

    it(`drops the hold the moment the subject changes — the outline belonged to the other conversation`, async () => {
        const loading = ref(true);
        const subject = ref(`chat-1`);
        const revealed = reveal(loading, subject);

        vi.advanceTimersByTime(200);
        expect(revealed.value).toBe(true);

        subject.value = `chat-2`;
        loading.value = false;
        await nextTick();
        expect(revealed.value).toBe(false);
    });

    it(`lets a second wait on the same subject join the one already on screen`, async () => {
        const loading = ref(true);
        const subject = ref(`chat-1`);
        const revealed = reveal(loading, subject);

        vi.advanceTimersByTime(200);
        loading.value = false;
        await nextTick();
        loading.value = true;
        await nextTick();
        // No second delay: the outline is already there, and taking it away for 200ms to put it back is the
        // flicker this exists to prevent.
        expect(revealed.value).toBe(true);
        vi.advanceTimersByTime(5_000);
        expect(revealed.value).toBe(true);
    });
});
