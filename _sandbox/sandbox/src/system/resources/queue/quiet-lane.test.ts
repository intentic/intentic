import { type GateProcess, laneInUse, type LaneReading, parseGateHolder, queueRunFlags, quietLaneOf } from "./quiet-lane.js";

/* The pure half of the quiet lane: what queue-run was asked, the gate's holder line, and the lane folded from the
   processes holding the gate's descriptors. The live half (a real gate taken by bin/queue-run) is
   quiet-lane.integration.test.ts. */

const QUEUE_RUN = ["bash", "/usr/local/bin/queue-run"];
const quietArgv = [...QUEUE_RUN, "--pool", "quiet", "--limit", "1", "--wait", "600", "--label", "quiet", "--exclusive", "--", "node", "launch.cjs"];
const buildArgv = [...QUEUE_RUN, "--pool", "heavy", "--limit", "2", "--label", "cargo", "--", "cargo", "build"];

const gateRow = (pid: number, over: Partial<GateProcess>): GateProcess => ({
    pid,
    ppid: 1,
    ageSeconds: 10,
    turnstile: false,
    running: false,
    argv: [],
    conversation: undefined,
    ...over,
});

const reading = (over: Partial<LaneReading>): LaneReading => ({ gate: [], holderLine: undefined, poolHolders: [], poolWaiters: [], ...over });

test("queue-run's flags are read up to the `--` that starts the command, and never from the command itself", () => {
    expect(queueRunFlags(quietArgv)).toEqual({ pool: "quiet", label: "quiet", exclusive: true });
    expect(queueRunFlags(buildArgv)).toEqual({ pool: "heavy", label: "cargo", exclusive: false });
    expect(queueRunFlags([...QUEUE_RUN, "--pool", "p", "--", "tool", "--exclusive", "--label", "x"])).toEqual({ pool: "p", label: undefined, exclusive: false });
    // A flag with nothing after it, or another flag where its value should be, names nothing.
    expect(queueRunFlags([...QUEUE_RUN, "--label", "--exclusive"])).toEqual({ pool: undefined, label: undefined, exclusive: true });
});

test("the gate's holder line is read as queue-run writes it, and anything else says nothing", () => {
    expect(parseGateHolder("4242 1764000000 quiet conv-a\n")).toEqual({ pid: 4242, label: "quiet", conversation: "conv-a" });
    expect(parseGateHolder("4242 1764000000 capture")).toEqual({ pid: 4242, label: "capture", conversation: undefined });
    expect(parseGateHolder(undefined)).toBeUndefined();
    expect(parseGateHolder("")).toBeUndefined();
    expect(parseGateHolder("not-a-pid 1764000000 quiet conv-a")).toBeUndefined();
    expect(parseGateHolder("4242 soon quiet conv-a")).toBeUndefined();
});

test("a sandbox with nothing at the gate has a free lane", () => {
    const lane = quietLaneOf(reading({}));
    expect(lane).toEqual({ holder: undefined, before: 0, waiting: [], held: [] });
    expect(laneInUse(lane)).toBe(false);
    expect(laneInUse(undefined)).toBe(false);
});

test("builds that were let in are not the lane in use: only a command running alone, or one waiting to, is", () => {
    const lane = quietLaneOf(reading({ gate: [gateRow(10, { running: true, argv: buildArgv }), gateRow(11, { running: true })] }));
    expect(lane.holder).toBeUndefined();
    expect(lane.before).toBe(0);
    expect(laneInUse(lane)).toBe(false);
});

test("the holder, the runs waiting for it and the builds it holds, each tree counted once at its top", () => {
    const lane = quietLaneOf(
        reading({
            gate: [
                // The quiet run that holds the gate, and the benchmark it started, which inherited both descriptors.
                gateRow(100, { turnstile: true, running: true, ageSeconds: 250, conversation: "sub-a" }),
                gateRow(101, { ppid: 100, turnstile: true, running: true, ageSeconds: 249, conversation: "sub-a" }),
                // Let in before it and still running: it waits for this one first.
                gateRow(200, { running: true, ageSeconds: 400, argv: buildArgv, conversation: "conv-x" }),
                // Two quiet runs at the turnstile, one with the `flock` it waits in.
                gateRow(300, { turnstile: true, ageSeconds: 60, argv: quietArgv, conversation: "sub-b" }),
                gateRow(301, { ppid: 300, turnstile: true, ageSeconds: 5, argv: ["flock", "-x", "-w", "30", "7"], conversation: "sub-b" }),
                gateRow(400, { turnstile: true, ageSeconds: 120, argv: quietArgv, conversation: "sub-c" }),
                // A build that came after it, held at the turnstile until it ends.
                gateRow(500, { turnstile: true, ageSeconds: 30, argv: buildArgv, conversation: "sub-b" }),
            ],
            holderLine: { pid: 100, label: "quiet", conversation: "sub-a" },
        }),
    );
    expect(lane.holder).toEqual({ pid: 100, conversation: "sub-a", label: "quiet", seconds: 250 });
    expect(lane.before).toBe(1);
    expect(lane.waiting.map((run) => [run.pid, run.conversation, run.label])).toEqual([
        [400, "sub-c", "quiet"],
        [300, "sub-b", "quiet"],
    ]);
    expect(lane.held).toEqual([{ pid: 500, conversation: "sub-b", label: "cargo", seconds: 30 }]);
    expect(laneInUse(lane)).toBe(true);
});

test("a holder line left by an earlier holder names nothing about this one", () => {
    const lane = quietLaneOf(
        reading({ gate: [gateRow(100, { turnstile: true, running: true, ageSeconds: 9, conversation: "conv-now" })], holderLine: { pid: 77, label: "capture", conversation: "conv-old" } }),
    );
    expect(lane.holder).toEqual({ pid: 100, conversation: "conv-now", label: undefined, seconds: 9 });
});

test("the holder's environment that could not be read is filled in from its own holder line", () => {
    const lane = quietLaneOf(reading({ gate: [gateRow(100, { turnstile: true, running: true })], holderLine: { pid: 100, label: "quiet", conversation: "conv-a" } }));
    expect(lane.holder?.conversation).toBe("conv-a");
});

test("a quiet run that took no gate still holds the quiet pool, and its pool's waiters join the line once each", () => {
    const lane = quietLaneOf(
        reading({
            gate: [gateRow(300, { turnstile: true, ageSeconds: 60, argv: quietArgv, conversation: "sub-b" })],
            poolHolders: [{ pid: 90, conversation: "conv-x", label: "quiet", seconds: 500 }],
            poolWaiters: [
                { pid: 300, label: "quiet", conversation: "sub-b", waitSeconds: 20, command: undefined },
                { pid: 310, label: "quiet", conversation: "sub-d", waitSeconds: 80, command: undefined },
            ],
        }),
    );
    expect(lane.holder).toEqual({ pid: 90, conversation: "conv-x", label: "quiet", seconds: 500 });
    expect(lane.waiting.map((run) => run.pid)).toEqual([310, 300]);
});
