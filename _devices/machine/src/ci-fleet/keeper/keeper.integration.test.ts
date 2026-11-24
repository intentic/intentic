import type { CiRunner } from "@intentic/sandbox-contract/schemas/ci-fleet";
import { exec, type FakeRunner, fakeSys, runnerFiles, runnerPrograms, testContext } from "../ci-fleet-testing.js";
import { keeperRound, keeperVerdict, newKeeperState } from "./fleet-keeper.js";

/* The keeper on a fake computer: which units it starts, which it leaves, how long it waits after a start that did not
   bring a runner back, and that a standing verdict reaches the log once. */

const WORKER_1 = "actions.runner.intentic-intentic.z440-worker-1.service";
const WORKER_2 = "actions.runner.intentic-intentic.z440-worker-2.service";
const T0 = Date.parse("2026-11-24T12:00:00Z");
const MIN = 60_000;

const starts = (calls: readonly string[][]) => calls.filter((call) => call[0] === "systemctl" && call[1] === "start").map((call) => call[2]);

const runner = (over: Partial<CiRunner>): CiRunner => ({ name: "w1", unit: WORKER_1, dir: "/r/1", user: "runner", light: false, state: "failed", busy: false, draining: false, ...over });

test("only a down runner nobody holds, drains or runs a job on is started", () => {
    expect(keeperVerdict(runner({}), undefined, T0)).toEqual({ kind: "start" });
    expect(keeperVerdict(runner({ state: "inactive" }), undefined, T0)).toEqual({ kind: "start" });
    expect(keeperVerdict(runner({ state: "active" }), undefined, T0)).toEqual({ kind: "up" });
    expect(keeperVerdict(runner({ busy: true }), undefined, T0)).toEqual({ kind: "up" });
    for (const held of ["board", "drain", "smoke"] as const) {
        expect(keeperVerdict(runner({ held }), undefined, T0).kind).toBe("leave");
    }
    expect(keeperVerdict(runner({ draining: true }), undefined, T0).kind).toBe("leave");
    expect(keeperVerdict(runner({ state: "not-installed" }), undefined, T0)).toMatchObject({ kind: "leave", why: expect.stringMatching(/gone from systemd.*svc\.sh install/u) });
    expect(keeperVerdict(runner({}), { tries: 1, retryAt: T0 + MIN }, T0)).toEqual({ kind: "wait", until: T0 + MIN });
});

test("a start that does not bring the runner back waits 10 minutes, then 20, and the runner coming back clears it", async () => {
    const runners: FakeRunner[] = [{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", state: "failed" }];
    const sys = fakeSys({ programs: runnerPrograms(runners), files: runnerFiles(runners), now: T0 });
    const { context, lines } = await testContext(sys);
    const state = newKeeperState();
    const at = async (minutes: number) => {
        sys.computer.now = T0 + minutes * MIN;
        return await keeperRound(context, state);
    };
    await at(0);
    await at(1);
    await at(9);
    expect(starts(sys.calls)).toEqual([WORKER_1]);
    await at(10);
    expect(starts(sys.calls)).toEqual([WORKER_1, WORKER_1]);
    await at(29);
    expect(starts(sys.calls)).toHaveLength(2);
    await at(30);
    expect(starts(sys.calls)).toHaveLength(3);
    runners[0] = { unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", state: "active" };
    const up = await at(31);
    expect(up.lines).toEqual([]);
    expect(lines.at(-1)).toBe("keeper: z440-worker-1 is back up");
    // The waiting verdict was said once between the starts, not every round.
    expect(lines.filter((line) => line.includes("the next start waits"))).toHaveLength(2);
    expect(context.status.read().keeper?.lines).toEqual([]);
});

test("a held runner and one whose unit is gone are each said once, and never started", async () => {
    const runners: FakeRunner[] = [
        { unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", state: "inactive", dropIns: "/run/systemd/system/x.d/intentic-paused.conf" },
        { unit: WORKER_2, dir: "/r/2", name: "z440-worker-2", state: "inactive" },
    ];
    const files = runnerFiles(runners);
    files.set("/run/intentic-ci/workers-paused", "");
    const sys = fakeSys({ programs: runnerPrograms(runners), files, now: T0 });
    const { context, lines } = await testContext(sys);
    await context.holds.change(() => ({ "z440-worker-2": { hold: "board", at: "2026-11-24T11:00:00Z", draining: false, after: "stay" } }));
    const state = newKeeperState();
    await keeperRound(context, state);
    const pass = await keeperRound(context, state);
    expect(starts(sys.calls)).toEqual([]);
    expect(pass.lines).toEqual(["z440-worker-1 is held down (smoke); left stopped", "z440-worker-2 is held down (board); left stopped"]);
    expect(lines).toEqual(["keeper: z440-worker-1 is held down (smoke); left stopped", "keeper: z440-worker-2 is held down (board); left stopped"]);
});

test("a start systemd refuses is said with systemd's words and backed off like one that did not stay up", async () => {
    const runners: FakeRunner[] = [{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", state: "failed" }];
    const sys = fakeSys({
        programs: runnerPrograms(runners, (command, args) => (command === "systemctl" && args[0] === "start" ? exec("", 1, "Unit not found.") : undefined)),
        files: runnerFiles(runners),
        now: T0,
    });
    const { context } = await testContext(sys);
    const state = newKeeperState();
    const pass = await keeperRound(context, state);
    expect(pass.lines[0]).toMatch(/could not start z440-worker-1 \(start 1, again in 10 min\).*Unit not found/u);
    sys.computer.now = T0 + 5 * MIN;
    await keeperRound(context, state);
    expect(starts(sys.calls)).toHaveLength(1);
});
