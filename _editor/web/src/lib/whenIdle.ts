// Runs a task when the page is idle: after the frame being drawn and any input waiting on it, which is where background
// writes belong on a phone, where a structured clone of a transcript landing on a tap is a tap that waits. Bounded by
// `timeout` so a page that is never idle still gets there. Safari has no idle callback, so a short timer stands in.
const FALLBACK_MS = 200;

export const whenIdle = (task: () => void, timeout = 2_000): void => {
    const view = globalThis.window;
    if (view === undefined) {
        task();
        return;
    }
    if (`requestIdleCallback` in view) {
        view.requestIdleCallback(() => task(), { timeout });
        return;
    }
    globalThis.setTimeout(task, FALLBACK_MS);
};
