// A page that slept: hidden for a long while, restored from the back-forward cache, or left on screen by a machine that
// slept. That last one says nothing through visibility (its timers just stop), so a beat that runs long after it was
// due is that sleep, told by the clock. Hidden beats are not read: a browser throttles a hidden page's timers to a
// minute or more, which is not a sleep.

// Long enough that a busy main thread never reads as a sleep; short enough that a laptop lid closed over lunch does.
export const WAKE_GAP_MS = 60_000;
const BEAT_MS = 15_000;

export const watchPageWake = (woke: () => void): (() => void) => {
    let hiddenAt: number | undefined = document.visibilityState === `hidden` ? Date.now() : undefined;
    let beatAt = Date.now();
    const visibilityChanged = (): void => {
        if (document.visibilityState === `hidden`) {
            hiddenAt = Date.now();
            return;
        }
        const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
        hiddenAt = undefined;
        beatAt = Date.now();
        if (away >= WAKE_GAP_MS) {
            woke();
        }
    };
    const restored = (event: PageTransitionEvent): void => {
        if (event.persisted) {
            beatAt = Date.now();
            woke();
        }
    };
    const beat = setInterval(() => {
        const now = Date.now();
        const late = now - beatAt - BEAT_MS;
        beatAt = now;
        if (late >= WAKE_GAP_MS && hiddenAt === undefined) {
            woke();
        }
    }, BEAT_MS);
    document.addEventListener(`visibilitychange`, visibilityChanged);
    window.addEventListener(`pageshow`, restored);
    return () => {
        clearInterval(beat);
        document.removeEventListener(`visibilitychange`, visibilityChanged);
        window.removeEventListener(`pageshow`, restored);
    };
};
