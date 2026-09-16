// @vitest-environment jsdom
//
// Needs jsdom: the follow's import chain reaches the app's router and theme, both of which touch the document.
import { describe, expect, it, vi } from "vitest";
import type { DevRebuildRun } from "../environment/useDevRebuild";

vi.mock(`../../../router`, () => ({ router: { push: vi.fn(), currentRoute: { value: { name: `chat`, params: {} } } } }));

const { rebuildReceipt } = await import("./restartWatch");

// A rebuild takes minutes and interrupts nothing, which is exactly why nobody watches it land: the reader is on
// another screen by then, and that is where the result has to arrive.

const run = (over: Partial<DevRebuildRun> = {}): DevRebuildRun => ({
    phase: `done`,
    startedAt: 1_000,
    endedAt: 217_000,
    lines: [],
    exitCode: 0,
    quietFor: 0,
    trouble: undefined,
    heardAt: 217_000,
    ...over,
});

describe(`what a settled rebuild is worth saying`, () => {
    it(`reports the build it just finished, and how long it took`, () => {
        const receipt = rebuildReceipt(`restarting`, run());
        expect(receipt?.title).toBe(`Rebuilt from your checkout in 3m 36s`);
        expect(receipt?.tone).toBe(`done`);
        expect(receipt?.actions?.[0]?.label).toBe(`See the log`);
    });

    it(`names the exit code when the machine refused the build`, () => {
        const receipt = rebuildReceipt(`building`, run({ phase: `failed`, exitCode: 100, trouble: `no space left on device` }));
        expect(receipt?.tone).toBe(`problem`);
        expect(receipt?.title).toContain(`exit 100`);
        expect(receipt?.detail).toBe(`no space left on device`);
    });

    it(`says a rebuild stopped reporting rather than calling it finished`, () => {
        expect(rebuildReceipt(`building`, run({ phase: `lost`, exitCode: undefined }))?.title).toContain(`stopped reporting`);
    });

    it(`counts no clock for a build adopted mid-flight, whose start nothing here saw`, () => {
        expect(rebuildReceipt(`building`, run({ startedAt: undefined }))?.title).toBe(`Rebuilt from your checkout in a few minutes`);
    });

    it(`stays quiet while the build is still running`, () => {
        expect(rebuildReceipt(`building`, run({ phase: `restarting` }))).toBeUndefined();
    });

    it(`stays quiet for a run that was already over, which nobody was waiting on`, () => {
        expect(rebuildReceipt(`done`, run())).toBeUndefined();
        expect(rebuildReceipt(undefined, run())).toBeUndefined();
    });
});
