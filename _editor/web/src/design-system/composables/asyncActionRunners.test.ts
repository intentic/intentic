import { useAsyncAction, useConcurrentActions } from "@intentic/ui/async";

/* Pinned here since @intentic/ui has no test runner of its own, and the surface that breaks is in this app: the
   workspace shares one runner between the file tree, the mobile browser and the editor's Ctrl+S.
   The two runners differ in exactly one thing, and it is the thing a caller has to choose between — a button that must
   not fire twice wants the mutex, and a surface whose actions are independent must never have the second one answered
   by doing nothing at all. */

// Resolves when the test says so, so a second call can be made while the first is still in flight.
const parked = (): { task: () => Promise<void>; finish: () => void; started: () => number } => {
    let started = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        task: async () => {
            started += 1;
            await gate;
        },
        finish: () => release(),
        started: () => started,
    };
};

describe(`useAsyncAction`, () => {
    it(`holds a second press back while the first is still running`, async () => {
        const { busy, run } = useAsyncAction();
        const first = parked();

        const running = run(first.task, `It failed.`);
        expect(busy.value).toBe(true);
        await run(first.task, `It failed.`);

        expect(first.started()).toBe(1);
        first.finish();
        await running;
        expect(busy.value).toBe(false);
    });
});

describe(`useConcurrentActions`, () => {
    it(`runs a second action instead of silently dropping it`, async () => {
        const { busy, run } = useConcurrentActions();
        const first = parked();
        const second = parked();

        const one = run(first.task, `It failed.`);
        const two = run(second.task, `It failed.`);

        expect(first.started()).toBe(1);
        expect(second.started()).toBe(1);
        expect(busy.value).toBe(true);
        first.finish();
        second.finish();
        await Promise.all([one, two]);
        expect(busy.value).toBe(false);
    });

    it(`stays busy until the last of a wave is done, not the first`, async () => {
        const { busy, run } = useConcurrentActions();
        const first = parked();
        const second = parked();

        const one = run(first.task, `It failed.`);
        const two = run(second.task, `It failed.`);
        first.finish();
        await one;

        expect(busy.value).toBe(true);
        second.finish();
        await two;
        expect(busy.value).toBe(false);
    });

    it(`keeps a failure visible through the actions still finishing beside it`, async () => {
        const { notice, run } = useConcurrentActions();
        const slow = parked();

        const running = run(slow.task, `The slow one failed.`);
        await run(async () => {
            throw new Error(`refused`);
        }, `Couldn't delete that.`);

        expect(notice.value?.title).toBe(`Couldn't delete that.`);
        expect(notice.value?.detail).toBe(`refused`);
        slow.finish();
        await running;
        // The wave is over and nothing overwrote the one thing in it that went wrong.
        expect(notice.value?.title).toBe(`Couldn't delete that.`);
    });

    it(`clears the previous wave's failure when a new wave starts`, async () => {
        const { notice, run } = useConcurrentActions();
        await run(async () => {
            throw new Error(`refused`);
        }, `Couldn't delete that.`);
        expect(notice.value?.title).toBe(`Couldn't delete that.`);

        await run(async () => undefined, `It failed.`);

        expect(notice.value).toBeUndefined();
    });
});
