import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSettings } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { createPrepushCheck } from "./prepush.js";

// The check touches sandboxSettings, workspace and logger; a cast keeps the fake that small. Nothing is
// persisted — the run lives in the returned object, which is the whole point of the rewrite.
const SETTINGS: Pick<SandboxSettings, "prepushCommand" | "prepushTimeoutMs"> = {
    prepushCommand: "exit 0",
    prepushTimeoutMs: 60_000,
};

interface Fakes {
    readonly services: Services;
    readonly settings: { current: typeof SETTINGS };
    // How many times the command has actually run — the "one suite at a time" assertion counts executions, not
    // results, because refusing a second run is precisely a claim about how often the child was spawned.
    readonly runs: () => number;
}

/* `ending` is the sugar the concurrency test needs: it becomes a command that RECORDS the fact it ran and then
 * ends that way, so "a second click starts nothing" can assert on executions rather than on the single result
 * two runs would also produce. Tests that care about the output pass `prepushCommand` outright instead. */
const fakeServices = (over: Partial<typeof SETTINGS> & { ending?: string } = {}): Fakes => {
    const root = mkdtempSync(join(tmpdir(), "prepush-"));
    const log = join(root, "runs.log");
    const { ending, ...fields } = over;
    const settings = {
        current: { ...SETTINGS, ...fields, ...(ending !== undefined ? { prepushCommand: `echo ran >> ${log}; ${ending}` } : {}) },
    };
    const services = {
        workspace: { root },
        sandboxSettings: { get: async () => settings.current },
        logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    } as unknown as Services;
    return {
        services,
        settings,
        runs: () =>
            existsSync(log)
                ? readFileSync(log, "utf8")
                      .trimEnd()
                      .split("\n")
                      .filter((line) => line !== "").length
                : 0,
    };
};

/* REAL timers throughout — deliberately, and it is worth saying why rather than leaving the next person to
 * rediscover it. This drives a real child process, and faking timers around one splits the clock from the event
 * loop: `advanceTimersByTime` fast-forwards the watchdog but a spawned `sh` still exits on the real one, so the
 * fake-timer version of these tests raced its own children AND poisoned the tests after it. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* THE RACE THE ROUTE'S `await` EXISTS FOR: the caller polls `state` the instant `run` resolves, so `run` must
 * not resolve before the child is visible. Resolving early handed that first poll an `idle`, which the push
 * dialog reads as "already settled" and closes itself over a check it never waited for. */
test("run resolves only once the run is visible to state", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 2; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    expect((await check.state()).status).toBe("running");
});

test("a zero exit is a passed result", async () => {
    const { services } = fakeServices({ prepushCommand: "echo all good; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), { timeout: 5_000 });
    const state = await check.state();
    expect(state.exitCode).toBe(0);
    expect(state.output).toContain("all good");
});

test("a non-zero exit is a failed result carrying the output", async () => {
    const { services } = fakeServices({ prepushCommand: "echo boom >&2; exit 3" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
    const state = await check.state();
    expect(state.exitCode).toBe(3);
    // stderr counts: a suite's failure summary is as likely to arrive there as on stdout.
    expect(state.output).toContain("boom");
});

// The dialog polls `state` for exactly this: a suite that prints for two minutes has to be visibly working, or
// the user cancels a run that was fine.
test("output streams into the state while the check is still running", async () => {
    const { services } = fakeServices({ prepushCommand: "echo first; sleep 2; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(
        async () => {
            const state = await check.state();
            expect(state.status).toBe("running");
            expect(state.output).toContain("first");
        },
        { timeout: 5_000 },
    );
});

// Two suites at once would fight over the same tree, the same ports and the same CPU — and the second would
// answer about a tree the first is still changing.
test("a second run while one is going starts nothing", async () => {
    const { services, runs } = fakeServices({ ending: "sleep 1; exit 0" });
    const check = createPrepushCheck(services);
    // Two in the SAME TICK, which is the case `running` alone cannot guard: reading the settings is an await, so
    // both calls would find no run in flight and spawn a suite each.
    await Promise.all([check.run(), check.run()]);
    await vi.waitFor(async () => expect((await check.state()).status).toBe("running"), { timeout: 5_000 });
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), { timeout: 8_000 });
    expect(runs()).toBe(1);
}, 20_000);

/* The guard this module exists for: a check that outruns its ceiling must be LOUD, never a pass and never a
 * silent skip. `sleep` is the shape that proves the process-GROUP kill works — signalling `sh`'s own pid leaves
 * the descendant holding stdout open, and `close` then waits out the full sleep. */
test("a check that outruns the timeout is failed and timedOut, never passed", async () => {
    // Below the schema's own 60s floor, which only guards what a user can type — the fake reads the field
    // directly, and a real ceiling would make this test take a minute to assert a branch that takes 150ms.
    const { services } = fakeServices({ prepushCommand: "sleep 30", prepushTimeoutMs: 150 });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
    expect((await check.state()).timedOut).toBe(true);
}, 20_000);

// A cancel must not read as a failure: nothing was learned about the code, and a "tests failed" dialog over a
// run the user stopped themselves would be the check lying about its own evidence.
test("a cancelled run is cancelled, not failed", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 30" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("running"), { timeout: 5_000 });
    check.cancel();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("cancelled"), { timeout: 5_000 });
}, 20_000);

// The timeout's own SIGTERM must not be reported as the user cancelling — the one outcome this check most needs
// to be loud about would be filed as "you stopped it".
test("a timeout is not reported as a cancellation", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 30", prepushTimeoutMs: 150 });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
}, 20_000);

/* An unrunnable command is `error`, not `failed`, and the distinction is the whole reason the status exists: a
 * failed check means the code is broken and an agent can fix it, while this means the SETTING is wrong. Seeding
 * a fix turn from it would send an agent hunting a bug that isn't there. */
test("a command that cannot be spawned is an error, not a failure", async () => {
    const { services } = fakeServices({ prepushCommand: "definitely-not-a-real-binary-xyz" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).not.toBe("running"), { timeout: 5_000 });
    const state = await check.state();
    // `sh` itself spawns fine and exits 127, so this is a FAILED run whose output names the problem. The `error`
    // status is for the spawn itself dying — no `sh`, an unreadable cwd — which this asserts is not what
    // happened, so the two paths stay distinguishable.
    expect(state.status).toBe("failed");
    expect(state.output).toContain("not found");
});

// Clearing the command turns the check off, and a result from before that must not go on gating a push — the
// user would be answering a dialog about a check nobody can run any more.
test("clearing the command reports idle, whatever the last run concluded", async () => {
    const { services, settings } = fakeServices({ prepushCommand: "exit 1" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
    settings.current = { ...settings.current, prepushCommand: "" };
    expect(await check.state()).toEqual({ status: "idle", command: "", output: "" });
});

// The same race from the other side: the setting was cleared between the click and the request reaching here.
test("run with no command configured spawns nothing", async () => {
    const { services, runs } = fakeServices({ prepushCommand: "" });
    const check = createPrepushCheck(services);
    await check.run();
    await wait(100);
    expect(runs()).toBe(0);
    expect((await check.state()).status).toBe("idle");
});
