import { exec, fakeSys, type FakeRunner, runnerFiles, runnerPrograms, testContext } from "./ci-fleet-testing.js";
import { drainLook, journalArgs, runnerOp } from "./units.js";

/* Starting, stopping and draining runners on a fake computer: what would have been run, and what the holds record. */

const WORKER_1 = "actions.runner.intentic-intentic.z440-worker-1.service";

const computer = (runners: FakeRunner[]) => fakeSys({ programs: runnerPrograms(runners), files: runnerFiles(runners) });
const stops = (calls: readonly string[][]) => calls.filter((call) => call[0] === "systemctl" && (call[1] === "start" || call[1] === "stop")).map((call) => call.slice(1).join(" "));

test("stop refuses a runner running a job, and names the drain that would wait for it", async () => {
    const sys = computer([{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", worker: 77 }]);
    const { context } = await testContext(sys);
    await expect(runnerOp(context, "z440-worker-1", "stop")).rejects.toThrow(/running a job.*drain it instead/u);
    expect(stops(sys.calls)).toEqual([]);
});

test("a stop holds the runner down and a start lifts the hold", async () => {
    const sys = computer([{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1" }]);
    const { context } = await testContext(sys);
    expect(await runnerOp(context, "z440-worker-1", "stop")).toMatch(/stays stopped/u);
    expect((await context.holds.read())["z440-worker-1"]?.hold).toBe("board");
    await runnerOp(context, "z440-worker-1", "start");
    expect(await context.holds.read()).toEqual({});
    expect(stops(sys.calls)).toEqual([`stop ${WORKER_1}`, `start ${WORKER_1}`]);
});

test("a restart of a busy runner waits for its job, then stops and starts it, and leaves no hold", async () => {
    const runners: FakeRunner[] = [{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", worker: 77 }];
    const sys = computer(runners);
    const { context } = await testContext(sys);
    expect(await runnerOp(context, "z440-worker-1", "restart")).toMatch(/restarts the moment that job ends/u);
    await drainLook(context);
    expect(stops(sys.calls)).toEqual([]);
    runners[0] = { unit: WORKER_1, dir: "/r/1", name: "z440-worker-1" };
    await drainLook(context);
    expect(stops(sys.calls)).toEqual([`stop ${WORKER_1}`, `start ${WORKER_1}`]);
    expect(await context.holds.read()).toEqual({});
});

test("a drain of an idle runner stops it at once and holds it down as drained", async () => {
    const sys = computer([{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1" }]);
    const { context } = await testContext(sys);
    expect(await runnerOp(context, "z440-worker-1", "drain")).toMatch(/had no job/u);
    expect((await context.holds.read())["z440-worker-1"]).toMatchObject({ hold: "drain", draining: false });
});

test("a runner that is not there is named with the ones that are", async () => {
    const sys = computer([{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1" }]);
    const { context } = await testContext(sys);
    await expect(runnerOp(context, "omen-worker-9", "start")).rejects.toThrow(/No runner called "omen-worker-9".*z440-worker-1/u);
});

test("a systemctl that fails says so in its words", async () => {
    const runners = [{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1" }];
    const sys = fakeSys({
        programs: runnerPrograms(runners, (command, args) => (command === "systemctl" && args[0] === "start" ? exec("", 1, "Job for x failed because the control process exited") : undefined)),
        files: runnerFiles(runners),
    });
    const { context } = await testContext(sys);
    await expect(runnerOp(context, "z440-worker-1", "start")).rejects.toThrow(/control process exited/u);
    expect(journalArgs(WORKER_1, 50)).toEqual(["-u", WORKER_1, "-n", "50", "--no-pager", "-o", "short-iso"]);
});
