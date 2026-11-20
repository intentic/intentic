// HOW MANY TIMES A SECOND THE STAGE'S DISPLAY SHOWS A NEW PICTURE, measured on the page's main thread off
// requestAnimationFrame, whose callbacks run once per display refresh: the median interval over RATE_FRAMES frames,
// as whole Hz. A castd serving this viewer on its own computer's loopback runs the window's screen at that rate (up to
// its `--local-fps`), told it with the box (mediaSize.ts). Measured once per window the stage is in, and only when
// first asked: a popped-out pane may sit on another display, of another rate.

/** A window, as far as its frames are counted. */
export interface FrameWindow {
    readonly requestAnimationFrame: (callback: (time: number) => void) => number;
}

// Frame intervals a measurement takes: half a second at 60 Hz.
export const RATE_FRAMES = 30;

/** The display's rate in whole Hz from the times of successive frames: the median interval's; undefined with none. */
export const rateOf = (times: readonly number[]): number | undefined => {
    const intervals = times
        .slice(1)
        .map((time, at) => time - (times[at] ?? time))
        .filter((interval) => interval > 0)
        .sort((left, right) => left - right);
    const median = intervals[Math.floor(intervals.length / 2)];
    return median === undefined ? undefined : Math.round(1000 / median);
};

/** Counts `frames` intervals of `view`'s frames, and says the rate they make. */
export const measureRate = (view: FrameWindow, frames = RATE_FRAMES): Promise<number | undefined> =>
    new Promise((resolve) => {
        const times: number[] = [];
        const step = (time: number): void => {
            times.push(time);
            if (times.length > frames) {
                resolve(rateOf(times));
            } else {
                view.requestAnimationFrame(step);
            }
        };
        view.requestAnimationFrame(step);
    });

/** Each window's rate, measured at its first ask and shared by every ask after. */
export const displayRates = (measure: (view: FrameWindow) => Promise<number | undefined> = measureRate) => {
    const known = new WeakMap<FrameWindow, Promise<number | undefined>>();
    return (view: FrameWindow): Promise<number | undefined> => {
        const rate = known.get(view) ?? measure(view);
        known.set(view, rate);
        return rate;
    };
};

/** The page's own: one measurement per window, whichever picture asks first. */
export const displayRate = displayRates();
