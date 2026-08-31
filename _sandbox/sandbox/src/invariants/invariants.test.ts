import pino from "pino";
import { expect, test, vi } from "vitest";
import { createInvariantRegistry, type InvariantCheck } from "./invariants.js";

/* The registry's own promise: a check may say the daemon is wrong, and a check may itself be wrong, and NEITHER
 * of those is allowed to reach the daemon. Everything below is a variation on that. */

const silent = () => pino({ level: "silent" });

const check = (name: string, run: InvariantCheck["run"], on: InvariantCheck["on"] = ["sweep"]): InvariantCheck => ({ name, on, run });

test("a broken promise is reported, attributed, and never thrown", async () => {
    const registry = createInvariantRegistry(silent());
    registry.register("platform", [check("claim", ({ fail }) => fail("claim names pid 42"))]);

    const broken = await registry.run("sweep");

    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ owner: "platform", check: "claim", moment: "sweep", message: "claim names pid 42", broken: false });
    expect(registry.violations()).toHaveLength(1);
});

test("a check that throws on its own account is recorded as broken, not as evidence", async () => {
    const registry = createInvariantRegistry(silent());
    registry.register("agent", [
        check("journal", () => {
            throw new TypeError("cannot read properties of undefined");
        }),
    ]);

    const [violation] = await registry.run("sweep");

    // The distinction is the whole point: `broken` says the check failed to run, so nothing was learned about
    // the subject. Reading it as a violation of the promise is how a diagnostic starts lying.
    expect(violation).toMatchObject({ owner: "agent", broken: true });
    expect(violation?.message).toContain("undefined");
});

test("a check that never settles is bounded rather than holding the pass open", async () => {
    vi.useFakeTimers();
    try {
        const registry = createInvariantRegistry(silent());
        registry.register("agents", [check("hangs", () => new Promise<void>(() => {}))]);

        const pass = registry.run("sweep");
        await vi.advanceTimersByTimeAsync(6_000);

        expect((await pass)[0]).toMatchObject({ owner: "agents", broken: true });
    } finally {
        vi.useRealTimers();
    }
});

test("a passing check reports nothing", async () => {
    const registry = createInvariantRegistry(silent());
    registry.register("capabilities", [check("manifest", () => {})]);

    expect(await registry.run("sweep")).toEqual([]);
    expect(registry.violations()).toEqual([]);
});

test("only the checks armed for the moment run", async () => {
    const registry = createInvariantRegistry(silent());
    const atBoot = vi.fn();
    const atSweep = vi.fn();
    registry.register("platform", [check("boot-only", atBoot, ["boot"]), check("sweep-only", atSweep, ["sweep"])]);

    await registry.run("boot");

    expect(atBoot).toHaveBeenCalledOnce();
    expect(atSweep).not.toHaveBeenCalled();
});

test("passes are serialized, so two moments landing together cannot read one state twice", async () => {
    const registry = createInvariantRegistry(silent());
    let inFlight = 0;
    let overlapped = false;
    registry.register("agent", [
        check(
            "counts",
            async () => {
                inFlight += 1;
                overlapped ||= inFlight > 1;
                await Promise.resolve();
                inFlight -= 1;
            },
            ["sweep", "turn-settled"],
        ),
    ]);

    await Promise.all([registry.run("sweep"), registry.run("turn-settled"), registry.run("sweep")]);

    expect(overlapped).toBe(false);
});

test("wiring mistakes are loud, because nothing is running yet when they are made", () => {
    const registry = createInvariantRegistry(silent());
    registry.register("platform", [check("claim", () => {})]);

    expect(() => registry.register("platform", [])).toThrow(/already registered/);
    expect(() => registry.register("agent", [check("same", () => {}), check("same", () => {})])).toThrow(/two checks named/);
});

test("disposal removes an owner's checks", async () => {
    const registry = createInvariantRegistry(silent());
    const dispose = registry.register("platform", [check("claim", ({ fail }) => fail("broken"))]);

    expect(registry.owners()).toEqual(["platform"]);
    dispose();

    expect(registry.owners()).toEqual([]);
    expect(await registry.run("sweep")).toEqual([]);
});

test("the violation list is bounded: it is a live signal, not a ledger", async () => {
    const registry = createInvariantRegistry(silent());
    registry.register("platform", [check("claim", ({ fail }) => fail("still broken"))]);

    for (let pass = 0; pass < 250; pass += 1) {
        await registry.run("sweep");
    }

    expect(registry.violations()).toHaveLength(200);
});
