import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { effectScope, nextTick, ref } from "vue";
import { useTranscriptWarmup } from "../useTranscriptWarmup";

// The pass that lays out every drawn row for an honest scrollbar: run at idle for a transcript a frame can afford, and
// skipped for one drawn so far up that it would hold the main thread for a long task.

afterEach(() => {
    unstubAllGlobals();
});

const warmup = (drawn: number): { readonly realizing: () => boolean; readonly idle: (() => void)[]; readonly stop: () => void } => {
    const idle: (() => void)[] = [];
    stubGlobal(`requestIdleCallback`, (callback: () => void) => idle.push(callback));
    const scope = effectScope();
    const { realizing } = scope.run(() =>
        useTranscriptWarmup({ conversationId: ref(`a`), messageCount: ref(drawn), streaming: ref(false), drawn: () => drawn }),
    )!;
    return { realizing: () => realizing.value, idle, stop: () => scope.stop() };
};

it(`lays out the drawn rows once the page is idle`, async () => {
    const { realizing, idle, stop } = warmup(300);
    idle.shift()?.();
    await nextTick();
    expect(realizing()).toBe(true);
    stop();
});

it(`leaves a transcript drawn far past its window to its estimated heights`, async () => {
    const { realizing, idle, stop } = warmup(4000);
    idle.shift()?.();
    await nextTick();
    expect(realizing()).toBe(false);
    stop();
});
