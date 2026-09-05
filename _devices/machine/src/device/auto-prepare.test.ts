import type { DeviceSandbox } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { autoPrepareArgs, newState, prepareTargets, runTick, ticksToSkip } from "./auto-prepare.js";

/* The tick's DECISIONS, without timers or docker: which sandboxes it may touch, what a failure does to the
 * next tick, and that it stays out of the way of work a person started. The judgement calls about WHAT to
 * download live in `ic sandbox prepare --auto` (recreate.rs) on purpose, so there is deliberately no test
 * here about channels, pinned images or disk — this file must never grow a second copy of those rules. */

const box = (slug: string, running = true): DeviceSandbox => ({
    slug,
    container: `intentic-sandbox-${slug}`,
    running,
    image: "ghcr.io/intentic/sandbox:1",
});

const quiet = (): void => undefined;

// A fake `prepare` that records which slugs ran and answers with one outcome.
const recording =
    (ran: string[], code = 0) =>
    (slug: string): Promise<{ code: number; output: string }> => {
        ran.push(slug);
        return Promise.resolve({ code, output: "ok" });
    };

test("only running, person-owned sandboxes are prepared: stopped ones wait for their next start, runners belong to their parent", () => {
    expect(prepareTargets([box("work"), box("asleep", false), box("runner-abc123"), box("runner-abc123", false)])).toEqual(["work"]);
});

test("the exact command line carries --auto: without it, ic would run the attended flow's judgement calls unattended", () => {
    expect(autoPrepareArgs("work")).toEqual(["sandbox", "prepare", "work", "--auto"]);
});

test("backoff doubles per consecutive failure and stops at the ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(ticksToSkip)).toEqual([0, 1, 2, 4, 8, 8, 8]);
});

test("a tick prepares each eligible sandbox once and reports ic's own last sentence", async () => {
    const state = newState();
    const ran: string[] = [];
    const lines: string[] = [];
    await runTick(
        state,
        [box("one"), box("two")],
        (slug) => {
            ran.push(slug);
            return Promise.resolve({ code: 0, output: "intentic: pulling…\nintentic: 1.2.3 is downloaded and built\n" });
        },
        (line) => lines.push(line),
        new Set(),
    );
    expect(ran).toEqual(["one", "two"]);
    expect(lines).toEqual([
        "auto-prepare one: intentic: 1.2.3 is downloaded and built",
        "auto-prepare two: intentic: 1.2.3 is downloaded and built",
    ]);
});

test("a failing sandbox sits out doubling ticks, and its first success clears the history", async () => {
    const state = newState();
    let outcome = 1;
    const ran: string[] = [];
    const tick = async (): Promise<void> => {
        await runTick(
            state,
            [box("work")],
            (slug) => {
                ran.push(slug);
                return Promise.resolve({ code: outcome, output: "boom" });
            },
            quiet,
            new Set(),
        );
    };
    await tick(); // fails → sits out 1
    await tick(); // sat out
    await tick(); // fails again → sits out 2
    await tick(); // sat out
    await tick(); // sat out
    expect(ran).toHaveLength(2);
    outcome = 0;
    await tick(); // retries and succeeds
    expect(ran).toHaveLength(3);
    await tick(); // history cleared: runs again immediately
    expect(ran).toHaveLength(4);
});

test("a prepare that THROWS (no ic on this machine) is a failure with backoff, not an unhandled rejection", async () => {
    const state = newState();
    const lines: string[] = [];
    await runTick(state, [box("work")], () => Promise.reject(new Error("This device has no `ic` command")), (line) => lines.push(line), new Set());
    expect(lines).toEqual(["auto-prepare work: failed (attempt 1, retrying after 1 tick(s)) — This device has no `ic` command"]);
    // …and the sit-out is honoured on the next tick.
    const ran: string[] = [];
    await runTick(state, [box("work")], recording(ran), quiet, new Set());
    expect(ran).toEqual([]);
});

test("a slug a person's flow is touching right now is left alone this tick", async () => {
    const ran: string[] = [];
    await runTick(newState(), [box("work"), box("other")], recording(ran), quiet, new Set(["work"]));
    expect(ran).toEqual(["other"]);
});

test("a sandbox that left this machine takes its failure history with it", async () => {
    const state = newState();
    await runTick(state, [box("gone")], () => Promise.resolve({ code: 1, output: "boom" }), quiet, new Set());
    expect(state.failures.get("gone")).toBe(1);
    // The slug is absent this tick — a future sandbox reusing the name must start clean.
    await runTick(state, [], () => Promise.resolve({ code: 0, output: "ok" }), quiet, new Set());
    expect(state.failures.size).toBe(0);
    expect(state.waits.size).toBe(0);
});
