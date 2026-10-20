// WORK THAT OUTLIVES ITS VIEW. A view here is an effect scope: what a component's setup is, and what its unmount
// stops. What is pinned is the promise the ledger makes to a reader who leaves mid-run: the run, its log and its end
// are still there when they come back, and only once they have read the end does it go.
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { forgetHubWork, hubWorkRunning } from "../hub/hubWork";
import { useNotifications } from "../notifications/notifications";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import {
    dismissOperation,
    forgetOperations,
    OperationGaveUp,
    operationAt,
    operationRunning,
    startOperation,
    useOperation,
    useOperations,
} from "./operations";

const KEY = `devices/omen/runner`;

// A promise this test settles by hand, so a run can be left mid-flight while views come and go.
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

const mount = <V>(setup: () => V): { view: V; scope: EffectScope } => {
    const scope = effectScope();
    const view = scope.run(setup) as V;
    return { view, scope };
};

const sandboxBefore = activeSandboxId.value;

afterEach(() => {
    jest.useRealTimers();
    forgetOperations();
    forgetHubWork();
    useNotifications().dismissReceipt();
    activeSandboxId.value = sandboxBefore;
});

it(`keeps a run, its lines and its end through the view that started it leaving and another coming back`, async () => {
    const work = deferred<string>();
    const first = mount(() => useOperation<string>(KEY));
    const ended = first.view.run({
        what: `Adding runner omen`,
        failed: `Couldn't add runner omen`,
        task: async (report) => {
            report.line(`pulling image`);
            return work.promise;
        },
    });
    expect(first.view.busy.value).toBe(true);
    first.scope.stop();

    const back = mount(() => useOperation<string>(KEY));
    expect(back.view.busy.value).toBe(true);
    expect(back.view.lines.value).toEqual([`pulling image`]);

    work.resolve(`runner omen is up`);
    await ended;
    expect(back.view.busy.value).toBe(false);
    expect(back.view.value.value).toBe(`runner omen is up`);
    back.scope.stop();
});

it(`refuses a second start under a key that is still running, which is the button pressed again on return`, async () => {
    const work = deferred<void>();
    const started = startOperation(KEY, { what: `Adding`, failed: `No`, task: () => work.promise });
    let second = false;
    expect(
        await startOperation(KEY, {
            what: `Adding`,
            failed: `No`,
            task: async () => {
                second = true;
            },
        }),
    ).toBeUndefined();
    expect(second).toBe(false);
    work.resolve();
    expect((await started)?.state).toBe(`done`);
});

it(`keeps an outcome that ended unwatched until a view has shown it and closed`, async () => {
    const work = deferred<void>();
    const started = startOperation(KEY, { what: `Adding`, failed: `Couldn't add`, task: () => work.promise });
    work.reject(new Error(`docker: no space left`));
    await started;

    expect(operationAt(KEY)?.failure).toEqual({ tone: `danger`, title: `Couldn't add`, detail: `docker: no space left` });
    const view = mount(() => useOperation(KEY));
    expect(view.view.failure.value?.title).toBe(`Couldn't add`);
    view.scope.stop();
    expect(operationAt(KEY)).toBeUndefined();
});

it(`puts away an outcome read where it ended once that view closes, as a component's own state always went`, async () => {
    const view = mount(() => useOperation(KEY));
    await view.view.run({ what: `Adding`, failed: `No`, task: async () => {} });
    expect(view.view.operation.value?.state).toBe(`done`);
    view.scope.stop();
    expect(operationAt(KEY)).toBeUndefined();
});

it(`raises a receipt only for a run that ended with nobody watching, and none for a quiet one`, async () => {
    const { receipt } = useNotifications();
    const watched = mount(() => useOperation(KEY));
    await watched.view.run({ what: `Adding`, failed: `No`, task: async () => {} });
    expect(receipt.value).toBeUndefined();
    watched.scope.stop();

    await startOperation(KEY, { what: `Adding runner omen`, failed: `Couldn't add runner omen`, task: () => Promise.reject(new Error(`gone`)) });
    expect(receipt.value).toMatchObject({ tone: `problem`, title: `Couldn't add runner omen`, detail: `gone` });

    useNotifications().dismissReceipt();
    await startOperation(`quiet`, { what: `Syncing`, failed: `No`, quiet: true, task: async () => {} });
    expect(receipt.value).toBeUndefined();
});

it(`says the end in the starter's own past tense when it gave one`, async () => {
    const { receipt } = useNotifications();
    await startOperation(KEY, { what: `Adding runner omen`, failed: `No`, done: () => `Runner omen added`, task: async () => `ignored` });
    expect(receipt.value?.title).toBe(`Runner omen added`);
});

it(`files a view's own failure shape, and its receipt reads the notice inside it`, async () => {
    const { receipt } = useNotifications();
    const view = mount(() => useOperation<void, { notice: { tone: `danger`; title: string }; command: string }>(KEY));
    view.scope.stop();
    await startOperation<void, { notice: { tone: `danger`; title: string }; command: string }>(KEY, {
        what: `Adding`,
        failed: (_error, lines) => ({ notice: { tone: `danger`, title: `Couldn't add` }, command: `ic runner add omen # after ${lines.length}` }),
        task: async (report) => {
            report.line(`one`);
            throw new Error(`no`);
        },
    });
    expect(operationAt<void, { notice: { tone: `danger`; title: string }; command: string }>(KEY)?.failure?.command).toBe(`ic runner add omen # after 1`);
    expect(receipt.value?.title).toBe(`Couldn't add`);
});

it(`shows a run only on the sandbox it began on, and again when that sandbox is back on screen`, async () => {
    activeSandboxId.value = `alpha`;
    const work = deferred<void>();
    const started = startOperation(KEY, { what: `Adding`, failed: `No`, task: () => work.promise });
    activeSandboxId.value = `beta`;
    expect(operationAt(KEY)).toBeUndefined();
    expect(operationRunning(`devices`)).toBe(false);
    activeSandboxId.value = `alpha`;
    expect(operationAt(KEY)?.state).toBe(`running`);
    work.resolve();
    await started;
});

it(`reads a family by scope: one row's run is busy for the whole subject, and its outcome is that row's alone`, async () => {
    const work = deferred<void>();
    const view = mount(() => useOperations(`devices/omen`));
    const started = view.view.run(`container/main`, { what: `Updating`, failed: `No`, task: () => work.promise });
    expect(view.view.busy.value).toBe(true);
    expect(view.view.at(`container/main`)?.state).toBe(`running`);
    expect(view.view.at(`container/other`)).toBeUndefined();
    expect(operationRunning(`devices`)).toBe(true);
    work.resolve();
    await started;
    expect(view.view.busy.value).toBe(false);
    view.scope.stop();
    expect(operationAt(`devices/omen/container/main`)).toBeUndefined();
});

it(`follows a view whose subject changes, so the old subject's outcome is put away and the new one's kept`, async () => {
    const host = ref(`omen`);
    await startOperation(`devices/rog/runner`, { what: `Adding`, failed: `No`, task: async () => {} });
    const view = mount(() => useOperation(() => `devices/${host.value}/runner`));
    await view.view.run({ what: `Adding`, failed: `No`, task: async () => {} });
    host.value = `rog`;
    await nextTick();
    expect(operationAt(`devices/omen/runner`)).toBeUndefined();
    expect(view.view.operation.value?.state).toBe(`done`);
    view.scope.stop();
    expect(operationAt(`devices/rog/runner`)).toBeUndefined();
});

it(`leaves running work alone when its notice is put away`, async () => {
    const work = deferred<void>();
    const started = startOperation(KEY, { what: `Adding`, failed: `No`, task: () => work.promise });
    dismissOperation(KEY);
    expect(operationAt(KEY)?.state).toBe(`running`);
    work.resolve();
    await started;
    dismissOperation(KEY);
    expect(operationAt(KEY)).toBeUndefined();
});

it(`keeps the newest lines of a run that prints without end`, async () => {
    await startOperation(KEY, {
        what: `Building`,
        failed: `No`,
        quiet: true,
        task: async (report) => {
            for (let line = 0; line < 700; line += 1) {
                report.line(`line ${line}`);
            }
        },
    });
    const lines = operationAt(KEY)?.lines ?? [];
    expect(lines.length).toBe(500);
    expect(lines.at(-1)).toBe(`line 699`);
});

it(`marks the hub row it was started from for as long as it runs`, async () => {
    const work = deferred<void>();
    const started = startOperation(KEY, { what: `Adding runner omen`, failed: `No`, task: () => work.promise }, { hub: `sandbox:devices` });
    expect(hubWorkRunning(`sandbox:devices`)).toBe(`Adding runner omen`);
    work.resolve();
    await started;
    expect(hubWorkRunning(`sandbox:devices`)).toBeUndefined();
});

it(`keeps an answer that can never be asked for again until it is put away by hand, read or not`, async () => {
    const view = mount(() => useOperation<string>(KEY));
    await view.view.run({ what: `Minting a token`, failed: `No`, keep: true, task: async () => `ic_secret` });
    view.scope.stop();
    expect(operationAt<string>(KEY)?.value).toBe(`ic_secret`);
    dismissOperation(KEY);
    expect(operationAt(KEY)).toBeUndefined();
});

it(`files the account's own work once for every sandbox, so any of them reads it and none can start it twice`, async () => {
    activeSandboxId.value = `alpha`;
    const work = deferred<void>();
    const started = startOperation(`account/billing/tier`, { what: `Moving`, failed: `No`, task: () => work.promise });
    activeSandboxId.value = `beta`;
    expect(operationAt(`account/billing/tier`)?.state).toBe(`running`);
    expect(await startOperation(`account/billing/tier`, { what: `Moving`, failed: `No`, task: async () => {} })).toBeUndefined();
    work.resolve();
    await started;
});

// Every long run says how long it should take and when it gives up, declared once where it starts, and the give-up is
// kept rather than merely said: a readout promising "we'll show you what you can do after 3 minutes" over work the
// ledger would wait on forever was the bug this pins.
it(`keeps a run's expected length and give-up, and draws them through the one progress readout while it runs`, async () => {
    jest.useFakeTimers();
    const work = deferred<void>();
    const view = mount(() => useOperation(KEY));
    const ended = view.view.run({ what: `Cloning`, failed: `No`, expectedMs: 60_000, giveUpMs: 600_000, task: () => work.promise });
    expect(operationAt(KEY)).toMatchObject({ expectedMs: 60_000, giveUpMs: 600_000 });
    await advanceTimersByTimeAsync(2_000);
    expect(view.view.meter.value).toEqual({ elapsedMs: 2_000, expectedMs: 60_000, giveUpMs: 600_000, measured: undefined });
    work.resolve();
    await ended;
    expect(view.view.meter.value).toBeUndefined();
    view.scope.stop();
});

it(`ends a run as failed at its give-up time, aborting its signal, and never hears the task after`, async () => {
    jest.useFakeTimers();
    const work = deferred<string>();
    let aborted: unknown;
    const view = mount(() => useOperation<string>(KEY));
    const ended = view.view.run({
        what: `Publishing`,
        failed: (error) => ({ tone: `warning`, title: error instanceof OperationGaveUp ? `gave up after ${error.afterMs}` : `other` }),
        giveUpMs: 30_000,
        task: (report) => {
            report.signal.addEventListener(`abort`, () => (aborted = report.signal.reason));
            return work.promise;
        },
    });
    await advanceTimersByTimeAsync(29_999);
    expect(view.view.busy.value).toBe(true);
    await advanceTimersByTimeAsync(1);
    const run = await ended;
    expect(run?.state).toBe(`failed`);
    expect(view.view.failure.value?.title).toBe(`gave up after 30000`);
    expect(aborted).toBeInstanceOf(OperationGaveUp);
    work.resolve(`late`);
    await advanceTimersByTimeAsync(0);
    expect(operationAt(KEY)?.state).toBe(`failed`);
    expect(operationAt(KEY)?.value).toBeUndefined();
    view.scope.stop();
});

it(`never gives up on a run that declared no give-up`, async () => {
    jest.useFakeTimers();
    const work = deferred<void>();
    const ended = startOperation(KEY, { what: `Waiting`, failed: `No`, task: () => work.promise });
    await advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(operationRunning(KEY)).toBe(true);
    work.resolve();
    await ended;
});
