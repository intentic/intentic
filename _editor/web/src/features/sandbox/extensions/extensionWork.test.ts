// EXTENSION WORK OUTLIVES ITS DRAWER. Installs from Browse, the row verbs and the drawer's update are kept in the
// operations ledger under the extension they act on, so a collapsed row, the other pill or another page coming between
// the press and the end leaves the work marked as running, and its end waiting to be said.
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { type EffectScope, effectScope } from "vue";
import { forgetOperations, startOperation, useOperation, useOperations } from "../../../workbench/operations/operations";
import { useNotifications } from "../../../workbench/notifications/notifications";
import { drawerScope, endedNotice, extensionBusy, latestFailure, ROWS } from "./extensionWork";
import { INSTALLS, type InstallVerb, installNotice, installsInFlight } from "./installsInFlight";

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

afterEach(() => {
    forgetOperations();
    useNotifications().dismissReceipt();
});

it(`keeps an install from Browse in flight after Browse is unmounted, and refuses a second press`, async () => {
    const clone = deferred<InstallVerb>();
    const browse = mount(() => useOperations<InstallVerb>(INSTALLS));
    const ended = browse.view.run(`acme.notes`, { what: `Installing acme.notes`, failed: `Could not install acme.notes.`, task: () => clone.promise });
    browse.scope.stop();

    expect(installsInFlight.value.has(`acme.notes`)).toBe(true);
    const again = mount(() => useOperations<InstallVerb>(INSTALLS));
    expect(await again.view.run(`acme.notes`, { what: `Installing acme.notes`, failed: `x`, task: async () => `install` })).toBeUndefined();

    clone.resolve(`install`);
    await ended;
    expect(installsInFlight.value.has(`acme.notes`)).toBe(false);
    expect(again.view.at(`acme.notes`)?.state).toBe(`done`);
    again.scope.stop();
});

it(`says an ended install in the section, carrying its key so dismissing puts it away`, async () => {
    const failed = await startOperation(`${INSTALLS}/acme.notes`, {
        what: `Installing acme.notes`,
        failed: `Could not install acme.notes.`,
        task: async (): Promise<InstallVerb> => {
            throw new Error(`clone refused`);
        },
    });
    const notice = installNotice(failed!, [], () => undefined);
    expect(notice?.tone).toBe(`danger`);
    expect(notice?.key).toBe(`${INSTALLS}/acme.notes`);

    const done = await startOperation(`${INSTALLS}/acme.board`, { what: `Installing acme.board`, failed: `x`, task: async (): Promise<InstallVerb> => `install` });
    let revealed: string | undefined = `never`;
    const said = installNotice(done!, [], (id) => {
        revealed = id;
    });
    expect(said?.tone).toBe(`info`);
    said?.action?.run();
    expect(revealed).toBeUndefined();
});

it(`counts the row, its drawer and Browse's update of it as one extension busy`, async () => {
    const swap = deferred<void>();
    const summary = { id: `acme.notes` } as unknown as ExtensionSummary;
    expect(extensionBusy(summary.id, `acme.notes`)).toBe(false);

    const drawer = mount(() => useOperation(() => `${drawerScope(summary.id)}/update/apply`));
    const applying = drawer.view.run({ what: `Updating acme.notes`, failed: `That didn't work.`, task: () => swap.promise });
    // The drawer collapses mid-apply: the row still reads it as busy, so its switch is held.
    drawer.scope.stop();
    expect(extensionBusy(summary.id, `acme.notes`)).toBe(true);
    swap.resolve();
    await applying;
    expect(extensionBusy(summary.id, `acme.notes`)).toBe(false);

    const install = deferred<InstallVerb>();
    const update = startOperation(`${INSTALLS}/acme.notes`, { what: `Updating acme.notes`, failed: `x`, task: () => install.promise });
    expect(extensionBusy(summary.id, `acme.notes`)).toBe(true);
    install.resolve(`update`);
    await update;

    const row = startOperation(`${ROWS}/${summary.id}`, { what: `Removing acme.notes`, failed: `x`, task: () => new Promise<void>(() => undefined) });
    expect(extensionBusy(summary.id)).toBe(true);
    void row;
});

it(`speaks for the newest press, and says a row verb's own sentence once it ends`, async () => {
    const first = await startOperation(`${drawerScope(`acme.notes`)}/update/preview`, {
        what: `Reading the update`,
        failed: `That didn't work.`,
        task: async () => {
            throw new Error(`offline`);
        },
    });
    const second = await startOperation(`${drawerScope(`acme.notes`)}/update/revert`, { what: `Reverting`, failed: `x`, task: async () => undefined });
    expect(latestFailure([first, second])).toBeUndefined();
    expect(latestFailure([second, first])).toBeUndefined();
    expect(latestFailure([first])?.title).toBe(`That didn't work.`);

    const removed = await startOperation(`${ROWS}/acme.notes`, {
        what: `Removing acme.notes`,
        failed: `x`,
        task: async () => ({ tone: `info` as const, title: `Removed acme.notes.` }),
    });
    expect(endedNotice(removed!, removed!.value)).toEqual({ tone: `info`, title: `Removed acme.notes.`, key: `${ROWS}/acme.notes` });
});
