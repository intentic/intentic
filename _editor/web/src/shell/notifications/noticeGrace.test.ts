import type { NoticeModel } from "@intentic/ui/notice";
import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_GRACE_MS, useNoticeGrace } from "./noticeGrace";

const lost: NoticeModel = { tone: `danger`, title: `Lost contact with your sandbox.` };
const other: NoticeModel = { tone: `danger`, title: `Couldn't read your changes.` };

// The composable registers an onScopeDispose, so it needs a scope to belong to, and running each case inside
// one also proves the timer is cleaned up rather than left to fire into a torn-down view.
const inScope = async <T>(body: () => T): Promise<{ value: T; stop: () => void }> => {
    const scope = effectScope();
    const value = scope.run(body)!;
    await nextTick();
    return { value, stop: () => scope.stop() };
};

describe(`useNoticeGrace`, () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it(`says nothing about a failure that heals inside the grace`, async () => {
        const source = ref<NoticeModel | undefined>(undefined);
        const { value: said, stop } = await inScope(() => useNoticeGrace(source));

        source.value = lost;
        await nextTick();
        vi.advanceTimersByTime(NOTICE_GRACE_MS - 1);
        expect(said.value).toBeUndefined();

        source.value = undefined;
        await nextTick();
        vi.advanceTimersByTime(NOTICE_GRACE_MS);
        expect(said.value).toBeUndefined();
        stop();
    });

    it(`says one that survives it`, async () => {
        const source = ref<NoticeModel | undefined>(undefined);
        const { value: said, stop } = await inScope(() => useNoticeGrace(source));

        source.value = lost;
        await nextTick();
        vi.advanceTimersByTime(NOTICE_GRACE_MS);
        expect(said.value).toEqual(lost);
        stop();
    });

    it(`clears the moment it heals, without waiting for anything`, async () => {
        const source = ref<NoticeModel | undefined>(lost);
        const { value: said, stop } = await inScope(() => useNoticeGrace(source));
        vi.advanceTimersByTime(NOTICE_GRACE_MS);
        expect(said.value).toEqual(lost);

        source.value = undefined;
        await nextTick();
        expect(said.value).toBeUndefined();
        stop();
    });

    // A different claim has not survived anything yet, so it serves its own wait rather than inheriting one.
    it(`restarts the wait when the failure changes mid-grace`, async () => {
        const source = ref<NoticeModel | undefined>(undefined);
        const { value: said, stop } = await inScope(() => useNoticeGrace(source));

        source.value = lost;
        await nextTick();
        vi.advanceTimersByTime(NOTICE_GRACE_MS - 100);
        source.value = other;
        await nextTick();
        vi.advanceTimersByTime(100);
        expect(said.value).toBeUndefined();

        vi.advanceTimersByTime(NOTICE_GRACE_MS);
        expect(said.value).toEqual(other);
        stop();
    });

    // Once it is on screen the user may be part-way through reading it; swapping the words in place is calmer
    // than pulling the box and bringing a new one back a beat later.
    it(`updates the words in place once it is being said`, async () => {
        const source = ref<NoticeModel | undefined>(lost);
        const { value: said, stop } = await inScope(() => useNoticeGrace(source));
        vi.advanceTimersByTime(NOTICE_GRACE_MS);

        source.value = other;
        await nextTick();
        expect(said.value).toEqual(other);
        stop();
    });

    it(`never fires into a view that has gone`, async () => {
        const source = ref<NoticeModel | undefined>(undefined);
        const { value: said, stop } = await inScope(() => useNoticeGrace(source));
        source.value = lost;
        await nextTick();

        stop();
        vi.advanceTimersByTime(NOTICE_GRACE_MS * 2);
        expect(said.value).toBeUndefined();
    });
});
