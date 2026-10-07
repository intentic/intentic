import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "./lifecycle.js";

describe(`DisposableStore`, () => {
    it(`disposes everything it holds, once`, () => {
        const store = new DisposableStore();
        const stopped: string[] = [];
        store.push(() => stopped.push(`first`));
        store.push(() => stopped.push(`second`));

        store.dispose();
        store.dispose();

        expect(stopped).toEqual([`first`, `second`]);
    });

    /* The property the daemon's shutdown depends on. */
    it(`keeps disposing after a member throws, then reports the failures`, () => {
        const store = new DisposableStore();
        const stopped: string[] = [];
        store.push(() => stopped.push(`before`));
        store.push(() => {
            throw new Error(`bad stop`);
        });
        store.push(() => stopped.push(`after`));

        expect(() => store.dispose()).toThrow(`bad stop`);
        expect(stopped).toEqual([`before`, `after`]);
    });

    it(`aggregates when more than one member fails`, () => {
        const store = new DisposableStore();
        store.push(() => {
            throw new Error(`first`);
        });
        store.push(() => {
            throw new Error(`second`);
        });

        expect(() => store.dispose()).toThrow(AggregateError);
    });

    /* An async boot step landing after shutdown began is a real race, not a caller error. */
    it(`disposes a late arrival immediately instead of holding it`, () => {
        const store = new DisposableStore();
        store.dispose();
        const stop = jest.fn();

        store.add(toDisposable(stop));

        expect(stop).toHaveBeenCalledTimes(1);
        expect(store.size).toBe(0);
    });

    it(`releases one member early without touching the rest`, () => {
        const store = new DisposableStore();
        const one = toDisposable(jest.fn());
        const other = jest.fn();
        store.add(one);
        store.push(other);

        store.deleteAndDispose(one);

        expect(store.size).toBe(1);
        expect(other).not.toHaveBeenCalled();
    });

    // A supervisor's own dispose reaches back into the store that holds it. Emptying before disposing is what
    // keeps that from iterating a set being mutated underneath it.
    it(`survives a member that disposes the store from inside its own teardown`, () => {
        const store = new DisposableStore();
        const stopped: string[] = [];
        store.push(() => {
            stopped.push(`reentrant`);
            store.dispose();
        });
        store.push(() => stopped.push(`sibling`));

        store.dispose();

        expect(stopped).toEqual([`reentrant`, `sibling`]);
    });
});

describe(`DisposableStore.disposeWithin`, () => {
    /* The order a process's shutdown needs: the door that admits work closes before the work behind it. */
    it(`stops the newest member first`, async () => {
        const store = new DisposableStore();
        const stopped: string[] = [];
        store.push(() => stopped.push(`services`));
        store.push(() => stopped.push(`door`));

        await store.disposeWithin(1_000);

        expect(stopped).toEqual([`door`, `services`]);
    });

    it(`waits for an asynchronous stop before resolving`, async () => {
        const store = new DisposableStore();
        let finished = false;
        store.push(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finished = true;
        });

        const outcome = await store.disposeWithin(1_000);

        expect(finished).toBe(true);
        expect(outcome).toEqual({ failed: [], unfinished: 0 });
    });

    /* A stop that never settles must not hold the exit. */
    it(`gives up on a hanging stop at the deadline and counts it`, async () => {
        const store = new DisposableStore();
        store.push(() => new Promise(() => undefined));
        store.push(async () => undefined);

        const outcome = await store.disposeWithin(20);

        expect(outcome.unfinished).toBe(1);
    });

    it(`reports throwing and rejecting stops without stopping the rest`, async () => {
        const store = new DisposableStore();
        const stopped: string[] = [];
        store.push(() => stopped.push(`first`));
        store.push(() => {
            throw new Error(`threw`);
        });
        store.push(() => Promise.reject(new Error(`rejected`)));

        const outcome = await store.disposeWithin(1_000);

        expect(outcome.failed.map((error) => (error as Error).message).toSorted()).toEqual([`rejected`, `threw`]);
        expect(stopped).toEqual([`first`]);
    });

    it(`does nothing the second time`, async () => {
        const store = new DisposableStore();
        const stop = jest.fn();
        store.push(stop);

        await store.disposeWithin(1_000);
        await store.disposeWithin(1_000);
        store.dispose();

        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe(`Disposable`, () => {
    it(`releases what a subclass registered`, () => {
        const stop = jest.fn();
        class Subsystem extends Disposable {
            constructor() {
                super();
                this.register(toDisposable(stop));
            }
        }

        new Subsystem().dispose();

        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe(`MutableDisposable`, () => {
    it(`releases the previous value when a new one is assigned`, () => {
        const slot = new MutableDisposable();
        const first = jest.fn();
        slot.value = toDisposable(first);
        const second = jest.fn();

        slot.value = toDisposable(second);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it(`leaves the value alone when the same one is assigned again`, () => {
        const slot = new MutableDisposable();
        const stop = jest.fn();
        const only = toDisposable(stop);
        slot.value = only;

        slot.value = only;

        expect(stop).not.toHaveBeenCalled();
    });

    // Assigning into a disposed slot must not park a live handle nobody will ever release.
    it(`disposes a value assigned after the slot itself was disposed`, () => {
        const slot = new MutableDisposable();
        slot.dispose();
        const stop = jest.fn();

        slot.value = toDisposable(stop);

        expect(stop).toHaveBeenCalledTimes(1);
        expect(slot.value).toBeUndefined();
    });
});
