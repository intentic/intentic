import { stubGlobal } from "@intentic/testing/bun";
import { effectScope } from "vue";

// The kit's device composable reads the media queries as it loads, which the test DOM does not have.
stubGlobal(`matchMedia`, (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
const { useViewerLoad } = await import("./useViewerLoad");

// A promise the test settles by hand, so loads can finish in whatever order a slow file would make them.
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((settle, fail) => {
        resolve = settle;
        reject = fail;
    });
    return { promise, resolve, reject };
};

const mount = (failed?: (message: string) => void) => {
    const scope = effectScope();
    const load = scope.run(() => useViewerLoad(() => `Could not read this file.`, failed === undefined ? {} : { failed }))!;
    return { load, scope };
};

describe(`useViewerLoad`, () => {
    it(`is loading from the start, and stops once a load settles`, async () => {
        const { load } = mount();
        expect(load.loading.value).toBe(true);
        const file = deferred<void>();
        const running = load.start(() => file.promise);
        expect(load.loading.value).toBe(true);
        file.resolve();
        await running;
        expect(load.loading.value).toBe(false);
        expect(load.error.value).toBeUndefined();
    });

    it(`drops a slow load for the previous file that finishes after the current one`, async () => {
        const { load } = mount();
        const shown: string[] = [];
        const slow = deferred<string>();
        const fast = deferred<string>();
        const show = (pending: Promise<string>) =>
            load.start(async (isLatest) => {
                const text = await pending;
                if (isLatest()) {
                    shown.push(text);
                }
            });

        const first = show(slow.promise);
        const second = show(fast.promise);
        fast.resolve(`current file`);
        await second;
        expect(load.loading.value).toBe(false);

        // The earlier load answering late neither draws, nor turns the spinner back on, nor reports an error.
        slow.resolve(`previous file`);
        await first;
        expect(shown).toEqual([`current file`]);
        expect(load.loading.value).toBe(false);
        expect(load.error.value).toBeUndefined();
    });

    it(`keeps a stale load's failure off the pane`, async () => {
        const { load } = mount();
        const slow = deferred<void>();
        const first = load.start(() => slow.promise);
        const current = deferred<void>();
        const second = load.start(() => current.promise);

        slow.reject(new Error(`the previous file was corrupt`));
        await first;
        expect(load.error.value).toBeUndefined();
        expect(load.loading.value).toBe(true);

        current.resolve();
        await second;
        expect(load.loading.value).toBe(false);
    });

    it(`says what failed in the error's own words, and reports it to whoever asked`, async () => {
        const reported: string[] = [];
        const { load } = mount((message) => reported.push(message));
        await load.start(async () => {
            throw new Error(`Sheet "Data" does not exist.`);
        });
        expect(load.error.value).toBe(`Sheet "Data" does not exist.`);
        expect(load.loading.value).toBe(false);
        expect(reported).toEqual([`Sheet "Data" does not exist.`]);
    });

    it(`falls back to the viewer's own sentence when the failure has no message`, async () => {
        const { load } = mount();
        await load.start(async () => {
            throw new Error(``);
        });
        expect(load.error.value).toBe(`Could not read this file.`);
    });

    it(`clears the previous error when the next load starts`, async () => {
        const { load } = mount();
        await load.start(async () => {
            throw new Error(`broken`);
        });
        const next = deferred<void>();
        const running = load.start(() => next.promise);
        expect(load.error.value).toBeUndefined();
        expect(load.loading.value).toBe(true);
        next.resolve();
        await running;
        expect(load.loading.value).toBe(false);
    });

    /* A refresh: the file changed on disk while open, which is how an agent's live edits reach a reader. */
    it(`draws a refresh over the last rendering, without a spinner`, async () => {
        const { load } = mount();
        await load.start(async () => {});
        expect(load.drawn()).toBe(true);
        const next = deferred<void>();
        const running = load.start(() => next.promise);
        expect(load.loading.value).toBe(false);
        next.resolve();
        await running;
        expect(load.loading.value).toBe(false);
        expect(load.stale.value).toBe(false);
    });

    it(`keeps the last rendering when a refresh fails, says it is stale, and clears that once one draws`, async () => {
        const reported: string[] = [];
        const { load } = mount((message) => reported.push(message));
        await load.start(async () => {});
        await load.start(async () => {
            throw new Error(`end of central directory not found`);
        });
        expect(load.error.value).toBeUndefined();
        expect(load.stale.value).toBe(true);
        expect(reported).toEqual([]);

        await load.start(async () => {});
        expect(load.stale.value).toBe(false);
    });

    it(`still reports a failure before anything drew as an error, not as stale`, async () => {
        const { load } = mount();
        await load.start(async () => {
            throw new Error(`broken`);
        });
        expect(load.drawn()).toBe(false);
        expect(load.stale.value).toBe(false);
        expect(load.error.value).toBe(`broken`);
    });

    it(`drops a load still running when the viewer closes`, async () => {
        const { load, scope } = mount();
        const file = deferred<void>();
        const running = load.start(() => file.promise);
        scope.stop();
        file.reject(new Error(`too late`));
        await running;
        expect(load.error.value).toBeUndefined();
        expect(load.loading.value).toBe(true);
    });
});
