import { Turns } from "./turns.js";

// A few at a time, the rest in order, and no queue without end: played with tasks the test finishes by hand.

// A task that runs until the test ends it, and says when it started.
const held = (started: string[], name: string) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    return {
        task: async (): Promise<string> => {
            started.push(name);
            return promise;
        },
        end: () => resolve(name),
    };
};

// Lets every task whose turn came start.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe(`Turns`, () => {
    it(`runs two at once, starts the next in order as each ends, and says when the queue is full`, async () => {
        const turns = new Turns(2, 1);
        const started: string[] = [];
        const [a, b, c] = [held(started, `a`), held(started, `b`), held(started, `c`)];
        const running = [turns.run(a.task), turns.run(b.task)];
        expect(turns.full()).toBe(false);
        const waiting = turns.run(c.task);
        await settle();
        expect([started, turns.full()]).toEqual([[`a`, `b`], true]);
        b.end();
        await settle();
        expect([started, turns.full()]).toEqual([[`a`, `b`, `c`], false]);
        a.end();
        c.end();
        expect(await Promise.all([...running, waiting])).toEqual([`a`, `b`, `c`]);
    });

    // A reader that throws must not keep its turn, or two failures would stop every later rendering.
    it(`frees a turn when its task fails`, async () => {
        const turns = new Turns(1, 1);
        await expect(turns.run(async () => { throw new Error(`unreadable`); })).rejects.toThrow(`unreadable`);
        expect(await turns.run(async () => `next`)).toBe(`next`);
        expect(turns.full()).toBe(false);
    });
});
