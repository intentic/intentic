import { useHoverIntent } from "@intentic/ui";

// Pins the one clock every hover-raised surface shares: a pointer that crosses raises nothing, one that overshoots can
// come back, and once a card is up the next one shows at once, a readiness that outlives the close by `warm`.

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(() => {
    jest.useRealTimers();
});

it(`opens only for a pointer that stays, and a crossing one raises nothing`, () => {
    const hover = useHoverIntent({ open: 160 });
    const opened = jest.fn();
    hover.enter(opened);
    jest.advanceTimersByTime(100);
    hover.leave();
    jest.advanceTimersByTime(500);
    expect([hover.shown.value, opened.mock.calls.length]).toEqual([false, 0]);

    hover.enter(opened);
    jest.advanceTimersByTime(159);
    expect(hover.shown.value).toBe(false);
    jest.advanceTimersByTime(1);
    expect([hover.shown.value, opened.mock.calls.length]).toEqual([true, 1]);
});

it(`keeps the surface through an overshoot that comes back within the grace`, () => {
    const hover = useHoverIntent({ open: 100, close: 150 });
    hover.show();
    hover.leave();
    jest.advanceTimersByTime(149);
    hover.enter();
    jest.advanceTimersByTime(1_000);
    expect(hover.shown.value).toBe(true);

    hover.leave();
    jest.advanceTimersByTime(150);
    expect(hover.shown.value).toBe(false);
});

it(`shows the next one at once while one is up, and for \`warm\` after it closes, then waits again`, () => {
    const hover = useHoverIntent({ open: 160, close: 150, warm: 300 });
    const shownFor: string[] = [];
    hover.show(() => shownFor.push(`a`));
    hover.enter(() => shownFor.push(`b`));
    hover.hide();
    jest.advanceTimersByTime(299);
    hover.enter(() => shownFor.push(`c`));
    hover.hide();
    jest.advanceTimersByTime(300);
    hover.enter(() => shownFor.push(`d`));
    expect([shownFor, hover.shown.value]).toEqual([[`a`, `b`, `c`], false]);
    jest.advanceTimersByTime(160);
    expect([shownFor, hover.shown.value]).toEqual([[`a`, `b`, `c`, `d`], true]);
});

it(`drops what is pending on cancel and leaves the surface as it is: the pointer reached the card`, () => {
    const hover = useHoverIntent({ close: 150 });
    hover.show();
    hover.leave();
    hover.cancel();
    jest.advanceTimersByTime(1_000);
    expect(hover.shown.value).toBe(true);
});
