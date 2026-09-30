// Resolves once the browser has had the chance to present a frame: the next animation frame, then a task after it, so
// whatever was rendered before the call is on screen by the time the caller carries on. It is how a press paints before
// the work it starts: on a phone a tap that builds a whole screen in the same task shows nothing at all until that
// screen is done, and reads as a tap that didn't land.
//
// A hidden page presents nothing and runs no animation frames, so there it resolves at once instead of waiting for the
// reader to come back; a frame that never arrives (a throttled frame, a busy compositor) is capped rather than awaited.
const CAP_MS = 100;

export const afterPaint = (): Promise<void> =>
    new Promise((resolve) => {
        if (!(`document` in globalThis) || !(`requestAnimationFrame` in globalThis) || document.visibilityState === `hidden`) {
            resolve();
            return;
        }
        let settled = false;
        const settle = (): void => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        const cap = setTimeout(settle, CAP_MS);
        requestAnimationFrame(() =>
            setTimeout(() => {
                clearTimeout(cap);
                settle();
            }, 0),
        );
    });
