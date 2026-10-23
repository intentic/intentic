import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { finishBoot, markBoot } from "./boot";
import { perfSpans } from "./perf";

afterEach(() => {
    jest.useRealTimers();
    unstubAllGlobals();
});

// One `boot` span per page: each link of the start counted the first time it is reached, none after the span is filed,
// and the span itself filed once, after the frame its first view drew in, whoever else reports a view later.
it(`files one boot span with the first reach of each link, and ignores every later one`, () => {
    jest.useFakeTimers();
    let frame: FrameRequestCallback | undefined;
    const requestFrame = jest.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
    });
    stubGlobal(`requestAnimationFrame`, requestFrame);

    markBoot(`main`);
    jest.advanceTimersByTime(10);
    markBoot(`session`);
    jest.advanceTimersByTime(5);
    markBoot(`session`);
    finishBoot(`agents`);
    finishBoot(`chat`);
    markBoot(`shell`);

    // A busy runner may present the frame well after 50 ms. Time alone must not file the span.
    jest.advanceTimersByTime(1_000);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(perfSpans(`boot`)).toEqual([]);
    frame?.(performance.now());
    expect(perfSpans(`boot`)).toEqual([]);
    jest.runOnlyPendingTimers();

    const spans = perfSpans(`boot`);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.fields[`route`]).toBe(`agents`);
    expect(span?.fields[`main`]).toBeTypeOf(`number`);
    expect(span?.fields[`session`]).toBe(10);
    expect(span?.fields[`shell`]).toBeUndefined();
    expect(span?.fields[`view`]).toBe(span?.ms);

    finishBoot(`workspace`);
    markBoot(`list`);
    jest.runOnlyPendingTimers();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(perfSpans(`boot`)).toEqual(spans);
});
