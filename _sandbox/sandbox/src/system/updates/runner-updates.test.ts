import type { DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import {
    judgeRunnerUpdate,
    newRunnerUpdateState,
    type RunnerUpdateDeps,
    type RunnerUpdateVerdict,
    type RunnerUpdateView,
    type RunnerUpdateWatch,
    runnerUpdateRetryMs,
    runRunnerUpdates,
} from "./runner-updates.js";

// A runner brought up to its parent's release, and every reason it is left alone instead: the omen case first (the
// runner set up on 1.406.0 under a 1.408.0 parent), then the guards that keep an update from cutting work or looping.

const OMEN: RunnerUpdateView = { id: "omen-runner", host: "radarsu-omen", online: true, version: "1.406.0" };
const IDLE_BEFORE: RunnerUpdateWatch = { idleAtLastLook: true, tries: 0, retryAt: 0 };

test("a runner on an older release than its parent, idle for two looks, is updated", () => {
    expect(judgeRunnerUpdate("1.408.0", OMEN, true, false, IDLE_BEFORE, 0)).toEqual({ kind: "update" });
});

test("a runner is left alone whenever an update would not help or would cut work", () => {
    const leave = (why: Extract<RunnerUpdateVerdict, { kind: "leave" }>["why"]): RunnerUpdateVerdict => ({ kind: "leave", why });
    expect(judgeRunnerUpdate("0.0.0", OMEN, true, false, IDLE_BEFORE, 0)).toEqual(leave("dev-build"));
    expect(judgeRunnerUpdate("1.408.0", { ...OMEN, version: "0.0.0" }, true, false, IDLE_BEFORE, 0)).toEqual(leave("dev-build"));
    expect(judgeRunnerUpdate("1.408.0", { ...OMEN, version: undefined }, true, false, IDLE_BEFORE, 0)).toEqual(leave("dev-build"));
    expect(judgeRunnerUpdate("1.408.0", { ...OMEN, version: "1.408.0" }, true, false, IDLE_BEFORE, 0)).toEqual(leave("current"));
    expect(judgeRunnerUpdate("1.408.0", { ...OMEN, version: "1.409.0" }, true, false, IDLE_BEFORE, 0)).toEqual(leave("current"));
    expect(judgeRunnerUpdate("1.408.0", { ...OMEN, online: false }, true, false, IDLE_BEFORE, 0)).toEqual(leave("offline"));
    expect(judgeRunnerUpdate("1.408.0", { ...OMEN, host: undefined }, false, false, IDLE_BEFORE, 0)).toEqual(leave("no-host"));
    expect(judgeRunnerUpdate("1.408.0", OMEN, false, false, IDLE_BEFORE, 0)).toEqual(leave("host-offline"));
    expect(judgeRunnerUpdate("1.408.0", OMEN, true, true, IDLE_BEFORE, 0)).toEqual(leave("busy"));
    expect(judgeRunnerUpdate("1.408.0", OMEN, true, false, { ...IDLE_BEFORE, idleAtLastLook: false }, 0)).toEqual(leave("settling"));
    expect(judgeRunnerUpdate("1.408.0", OMEN, true, false, { ...IDLE_BEFORE, retryAt: 10 }, 5)).toEqual(leave("backing-off"));
});

test("an update that did not bring the runner level waits longer each time, up to a day", () => {
    expect([0, 1, 2, 3, 4, 9].map(runnerUpdateRetryMs)).toEqual([0, 3_600_000, 10_800_000, 21_600_000, 86_400_000, 86_400_000]);
});

interface Harness {
    readonly deps: RunnerUpdateDeps;
    readonly asked: string[];
    readonly warned: unknown[];
    runner: RunnerUpdateView;
    busy: boolean;
    now: number;
    answer: DeviceFlowLine[];
}

const harness = (): Harness => {
    const h: Harness = {
        asked: [],
        warned: [],
        runner: OMEN,
        busy: false,
        now: 0,
        answer: [{ kind: "result", message: "Updated sandbox runner-omen-runner." }],
        deps: {
            own: "1.408.0",
            runners: async () => [h.runner],
            hostConnected: (host) => host === "radarsu-omen",
            busy: () => h.busy,
            async *update (host, slug) {
                h.asked.push(`${host}:${slug}`);
                yield* h.answer;
            },
            logger: { info: () => undefined, warn: (entry: unknown) => void h.warned.push(entry) },
            now: () => h.now,
        },
    };
    return h;
};

test("the first look only watches; the second, still idle, asks the runner's own machine to update it", async () => {
    const h = harness();
    const state = newRunnerUpdateState();
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toEqual([]);
    h.now = 600_000;
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toEqual(["radarsu-omen:runner-omen-runner"]);
    expect(h.warned).toEqual([]);
});

test("a turn on the runner at either look holds the update until two idle looks in a row", async () => {
    const h = harness();
    const state = newRunnerUpdateState();
    await runRunnerUpdates(state, h.deps);
    h.busy = true;
    await runRunnerUpdates(state, h.deps);
    h.busy = false;
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toEqual([]);
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toHaveLength(1);
});

test("an update that left the runner behind is asked again only after the back-off, and a level runner starts over", async () => {
    const h = harness();
    h.answer = [{ kind: "error", message: "low disk" }];
    const state = newRunnerUpdateState();
    await runRunnerUpdates(state, h.deps);
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toHaveLength(1);
    expect(h.warned).toHaveLength(1);
    // Idle again, but inside the hour.
    h.now = 10 * 60_000;
    await runRunnerUpdates(state, h.deps);
    h.now = 20 * 60_000;
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toHaveLength(1);
    h.now = 61 * 60_000;
    await runRunnerUpdates(state, h.deps);
    expect(h.asked).toHaveLength(2);
    // Brought level by somebody's button: the ladder is spent no more.
    h.runner = { ...OMEN, version: "1.408.0" };
    await runRunnerUpdates(state, h.deps);
    expect(state.watches.get("omen-runner")).toEqual({ idleAtLastLook: true, tries: 0, retryAt: 0 });
});

test("a removed runner is forgotten", async () => {
    const h = harness();
    const state = newRunnerUpdateState();
    await runRunnerUpdates(state, h.deps);
    expect(state.watches.has("omen-runner")).toBe(true);
    const gone: RunnerUpdateDeps = { ...h.deps, runners: async () => [] };
    await runRunnerUpdates(state, gone);
    expect(state.watches.size).toBe(0);
});
