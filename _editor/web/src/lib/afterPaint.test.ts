import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { afterPaint } from "./afterPaint";

afterEach(() => {
    unstubAllGlobals();
    // Only ever an own property set by the hidden-page case below; deleting it restores the prototype's getter.
    Reflect.deleteProperty(document, `visibilityState`);
});

it(`waits for the next frame and a task after it`, async () => {
    const order: string[] = [];
    let frame: FrameRequestCallback | undefined;
    stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
    });
    const painted = afterPaint().then(() => order.push(`resolved`));
    await Promise.resolve();
    order.push(`before frame`);
    frame?.(0);
    await painted;

    expect(order).toEqual([`before frame`, `resolved`]);
});

it(`resolves at once on a hidden page, which runs no frames`, async () => {
    const asked: number[] = [];
    stubGlobal(`requestAnimationFrame`, () => asked.push(1));
    Object.defineProperty(document, `visibilityState`, { configurable: true, get: () => `hidden` });

    await expect(afterPaint()).resolves.toBeUndefined();
    expect(asked).toEqual([]);
});

// A frame that never arrives is capped, not awaited: without the cap this test hangs instead of passing.
it(`gives up on a frame that never comes`, async () => {
    stubGlobal(`requestAnimationFrame`, () => 1);

    await expect(afterPaint()).resolves.toBeUndefined();
});
