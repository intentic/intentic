// The display's refresh rate as castd is told it: the median of a run of requestAnimationFrame intervals as whole Hz,
// measured once per window, on a fake window whose frames the test steps itself.
import { displayRates, type FrameWindow, measureRate, RATE_FRAMES, rateOf } from "./displayRate";

// A window whose frame callbacks run when the test says, `everyMs` apart.
const frameWindow = (everyMs: number) => {
    let now = 1000;
    let waiting: ((time: number) => void)[] = [];
    let asked = 0;
    const view: FrameWindow = {
        requestAnimationFrame: (callback) => {
            asked += 1;
            waiting.push(callback);
            return asked;
        },
    };
    return {
        view,
        asked: () => asked,
        // One display refresh: every callback waiting runs.
        frame: (): void => {
            now += everyMs;
            const due = waiting;
            waiting = [];
            due.forEach((callback) => callback(now));
        },
    };
};

it("reads whole Hz off the median interval between frames", () => {
    const at = (everyMs: number, count: number) => Array.from({ length: count }, (_, index) => index * everyMs);
    expect(rateOf(at(1000 / 60, 31))).toBe(60);
    expect(rateOf(at(1000 / 144, 31))).toBe(144);
    expect(rateOf(at(1000 / 59.94, 31))).toBe(60);
});

it("is not moved by a frame the page missed, nor by two callbacks in one frame", () => {
    // 50 Hz, with one frame missed (40 ms) and one callback run twice in a frame (0 ms).
    const times = [0, 20, 40, 60, 100, 120, 120, 140];
    expect(rateOf(times)).toBe(50);
});

it("reads nothing from fewer than two frames", () => {
    expect(rateOf([])).toBeUndefined();
    expect(rateOf([5])).toBeUndefined();
    expect(rateOf([5, 5])).toBeUndefined();
});

it("counts RATE_FRAMES intervals of the window's own frames, then asks for no more", async () => {
    const display = frameWindow(1000 / 120);
    const rate = measureRate(display.view);
    for (let frame = 0; frame < RATE_FRAMES + 5; frame += 1) {
        display.frame();
    }
    expect(await rate).toBe(120);
    expect(display.asked()).toBe(RATE_FRAMES + 1);
});

it("measures each window once, however many pictures ask, and another window on its own", async () => {
    const measured: FrameWindow[] = [];
    const rateOfWindow = displayRates(async (view) => {
        measured.push(view);
        return measured.length === 1 ? 60 : 144;
    });
    const editor = frameWindow(1000 / 60).view;
    const popout = frameWindow(1000 / 144).view;
    expect(await rateOfWindow(editor)).toBe(60);
    expect(await rateOfWindow(editor)).toBe(60);
    expect(await rateOfWindow(popout)).toBe(144);
    expect(measured).toEqual([editor, popout]);
});
