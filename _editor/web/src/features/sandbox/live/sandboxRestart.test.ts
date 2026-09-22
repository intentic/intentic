import "@intentic/testing/dom";
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { freshImport } from "@intentic/testing/bun";
import { expectRestart, forgetRestarts, type RestartWork, restartExpected, restartFinished, restartRunning } from "./sandboxRestart";

// Needs jsdom: the ledger's whole point is surviving the container that serves this page, which it does in
// localStorage.

const quiet = { title: `Restarting onto the image you built`, detail: `About half a minute, then this page reconnects.` };
const work = (over: Partial<RestartWork> = {}): Omit<RestartWork, "startedAt"> => ({
    sandbox: `sbx-1`,
    id: `dev-rebuild`,
    what: `Rebuilding from your checkout`,
    quiet,
    ...over,
});

beforeEach(() => {
    localStorage.clear();
    forgetRestarts();
});

afterEach(() => {
    forgetRestarts();
    localStorage.clear();
});

describe(`what the app knows about a coming restart`, () => {
    it(`says nothing about a sandbox nobody has asked anything of`, () => {
        expect(restartExpected(`sbx-1`)).toBeUndefined();
        expect(restartRunning(`sbx-1`)).toBeUndefined();
    });

    it(`carries the work while it runs and forgets it the moment it ends`, () => {
        const end = expectRestart(work());
        expect(restartRunning(`sbx-1`)).toBe(`Rebuilding from your checkout`);
        expect(restartExpected(`sbx-1`)?.quiet).toEqual(quiet);
        end();
        expect(restartRunning(`sbx-1`)).toBeUndefined();
        expect(restartExpected(`sbx-1`)).toBeUndefined();
    });

    it(`keeps one record while any surface still holds the same work`, () => {
        const fromTheRoot = expectRestart(work());
        const fromTheCard = expectRestart(work());
        fromTheCard();
        expect(restartRunning(`sbx-1`)).toBe(`Rebuilding from your checkout`);
        expect(localStorage.getItem(`intentic.restart.sbx-1.dev-rebuild`)).not.toBeNull();
        fromTheRoot();
        expect(restartRunning(`sbx-1`)).toBeUndefined();
        expect(localStorage.getItem(`intentic.restart.sbx-1.dev-rebuild`)).toBeNull();
    });

    it(`counts producers rather than listing them`, () => {
        expectRestart(work());
        expectRestart(work({ id: `update`, what: `Restarting this sandbox` }));
        expect(restartRunning(`sbx-1`)).toBe(`2 running`);
    });

    it(`never lets one sandbox's rebuild explain another's silence`, () => {
        expectRestart(work());
        expect(restartExpected(`sbx-2`)).toBeUndefined();
        expect(restartRunning(`sbx-2`)).toBeUndefined();
    });

    it(`answers with the newest, since that is the one the reader is waiting on`, () => {
        jest.useFakeTimers();
        try {
            expectRestart(work({ id: `update`, quiet: { title: `Restarting onto the update`, detail: `Half a minute.` } }));
            jest.advanceTimersByTime(1_000);
            expectRestart(work());
            expect(restartExpected(`sbx-1`)?.quiet.title).toBe(quiet.title);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe(`when the sandbox answers again`, () => {
    it(`leaves a producer that is still following its own work alone`, () => {
        expectRestart(work());
        restartFinished(`sbx-1`);
        expect(restartRunning(`sbx-1`)).toBe(`Rebuilding from your checkout`);
    });

    it(`ends a restart nobody here performs, which only the sandbox's return can finish`, () => {
        expectRestart(work({ id: `hosted-build`, what: `Restarting onto your new environment`, untilAnswered: true }));
        restartFinished(`sbx-1`);
        expect(restartExpected(`sbx-1`)).toBeUndefined();
        expect(localStorage.getItem(`intentic.restart.sbx-1.hosted-build`)).toBeNull();
    });
});

describe(`a reader who reloads mid-swap`, () => {
    const store = (over: Partial<RestartWork> = {}): void =>
        localStorage.setItem(`intentic.restart.sbx-1.dev-rebuild`, JSON.stringify({ ...work(), startedAt: Date.now(), ...over }));

    // A fresh import is the reload: the ledger reads storage once, at module load, exactly as the new page does.
    const reload = (): Promise<typeof import("./sandboxRestart")> => freshImport("./sandboxRestart", import.meta.url);

    it(`still knows why the sandbox is quiet`, async () => {
        store();
        const again = await reload();
        expect(again.restartExpected(`sbx-1`)?.quiet.title).toBe(quiet.title);
    });

    it(`never claims the work is being followed here, since nothing in this tab could end it`, async () => {
        store();
        const again = await reload();
        expect(again.restartRunning(`sbx-1`)).toBeUndefined();
    });

    it(`drops a record too old to be what the silence is`, async () => {
        store({ startedAt: Date.now() - 2 * 60 * 60_000 });
        const again = await reload();
        expect(again.restartExpected(`sbx-1`)).toBeUndefined();
        expect(localStorage.getItem(`intentic.restart.sbx-1.dev-rebuild`)).toBeNull();
    });

    it(`drops anything in that key that isn't a record`, async () => {
        localStorage.setItem(`intentic.restart.sbx-1.dev-rebuild`, `{"sandbox":"sbx-1"}`);
        const again = await reload();
        expect(again.restartExpected(`sbx-1`)).toBeUndefined();
    });
});
