import { finishBoot, markBoot } from "./boot";
import { perfSpans } from "./perf";

// One `boot` span per page: each link of the start counted the first time it is reached, none after the span is filed,
// and the span itself filed once, after the frame its first view drew in, whoever else reports a view later.
it(`files one boot span with the first reach of each link, and ignores every later one`, async () => {
    markBoot(`main`);
    markBoot(`session`);
    const first = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    markBoot(`session`);
    finishBoot(`agents`);
    finishBoot(`chat`);
    markBoot(`shell`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const spans = perfSpans(`boot`);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.fields[`route`]).toBe(`agents`);
    expect(span?.fields[`main`]).toBeTypeOf(`number`);
    expect(Number(span?.fields[`session`])).toBeLessThanOrEqual(Math.round(first));
    expect(span?.fields[`shell`]).toBeUndefined();
    expect(span?.ms).toBe(span?.fields[`view`]);
});
