import type { Logger } from "pino";
import { expect, test, vi } from "vitest";
import { createBootTracker } from "./boot.js";

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const tracker = () => {
    const boot = createBootTracker(silent);
    boot.declare([
        { key: "links", label: "Linking state" },
        { key: "registry", label: "Loading conversations" },
    ]);
    return boot;
};

test("a declared chain starts pending and not ready", () => {
    const boot = tracker();
    expect(boot.progress().ready).toBe(false);
    expect(boot.progress().steps.map((step) => step.state)).toEqual(["pending", "pending"]);
});

test("a step reports running, then done with its elapsed time", async () => {
    const boot = tracker();
    const seen: string[] = [];
    boot.subscribe((progress) => seen.push(progress.steps[0]!.state));
    await boot.step("links", async () => undefined);
    expect(seen).toEqual(["running", "done"]);
    expect(boot.progress().steps[0]?.ms).toBeTypeOf("number");
});

test("a failing step is recorded as failed and the error still propagates", async () => {
    const boot = tracker();
    await expect(boot.step("links", () => Promise.reject(new Error("no disk")))).rejects.toThrow("no disk");
    expect(boot.progress().steps[0]?.state).toBe("failed");
    // Log-and-continue: a failed step never blocks the gate, and the next one runs normally.
    await boot.step("registry", async () => undefined);
    expect(boot.progress().steps[1]?.state).toBe("done");
});

test("an undeclared step throws rather than running unnamed", async () => {
    const boot = tracker();
    await expect(boot.step("sweep", async () => undefined)).rejects.toThrow(/was run without being declared/);
});

test("finish opens the gate exactly once and broadcasts the ready snapshot", async () => {
    const boot = tracker();
    let opened = false;
    void boot.converged.then(() => {
        opened = true;
    });
    const snapshots: boolean[] = [];
    boot.subscribe((progress) => snapshots.push(progress.ready));
    boot.finish();
    boot.finish();
    await boot.converged;
    expect(opened).toBe(true);
    expect(snapshots).toEqual([true]);
});

test("a tracker with no declared chain is converged from birth", async () => {
    const boot = createBootTracker(silent);
    await expect(boot.converged).resolves.toBeUndefined();
    expect(boot.progress()).toMatchObject({ ready: true, steps: [] });
});

test("declaring closes the gate, so construction order cannot leak an early answer", async () => {
    const boot = createBootTracker(silent);
    // The app reads `converged` per request, not once at build time: a chain declared after the listeners
    // came up still holds the routes that arrive next.
    const early = boot.converged;
    boot.declare([{ key: "links", label: "Linking state" }]);
    let opened = false;
    void boot.converged.then(() => {
        opened = true;
    });
    await early;
    await Promise.resolve();
    expect(opened).toBe(false);
    boot.finish();
    await boot.converged;
    expect(opened).toBe(true);
});

test("a snapshot is a copy: a later transition cannot rewrite a frame already sent", async () => {
    const boot = tracker();
    const first = boot.progress();
    await boot.step("links", async () => undefined);
    expect(first.steps[0]?.state).toBe("pending");
});

test("unsubscribing stops delivery", async () => {
    const boot = tracker();
    const listener = vi.fn();
    boot.subscribe(listener)();
    await boot.step("links", async () => undefined);
    expect(listener).not.toHaveBeenCalled();
});
