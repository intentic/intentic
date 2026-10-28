import { artQueueState, noteScroll, queueArt, SETTLE_MS } from "./artQueue";

// Pins how the home's pictures are fetched: nothing while a scroll is in flight, the newest asks first once it rests, a
// bounded number at once, and an ask taken back before its turn never fetched.

// An ask the test settles by hand, recording that it started.
const started: string[] = [];
const finishers: (() => void)[] = [];
const ask = (name: string) => (): Promise<void> =>
    new Promise((resolve) => {
        started.push(name);
        finishers.push(resolve);
    });
const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
        await Promise.resolve();
    }
};

beforeEach(() => {
    jest.useFakeTimers();
    started.length = 0;
    finishers.length = 0;
});
afterEach(async () => {
    jest.advanceTimersByTime(SETTLE_MS);
    while (finishers.length > 0) {
        finishers.shift()?.();
        await settle();
    }
    jest.useRealTimers();
});

it(`holds every ask while a scroll is in flight, drops one taken back, and starts the newest first once it rests`, async () => {
    noteScroll();
    queueArt(ask(`first`));
    const takeBack = queueArt(ask(`flung past`));
    queueArt(ask(`last`));
    takeBack();
    jest.advanceTimersByTime(SETTLE_MS - 1);
    const during = [...started];
    jest.advanceTimersByTime(1);

    expect([during, started]).toEqual([[], [`last`, `first`]]);
});

it(`keeps a bounded number out at once and starts the next as one lands`, async () => {
    const names = Array.from({ length: 20 }, (_, index) => `tile ${index}`);
    for (const name of names) {
        queueArt(ask(name));
    }
    const { running, waiting } = artQueueState();
    finishers.shift()?.();
    await settle();

    expect([running + waiting, running < names.length, artQueueState().running, started.length]).toEqual([names.length, true, running, running + 1]);
});
