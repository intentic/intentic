import type { LaneRun, QuietLane } from "../../../system/resources/queue/quiet-lane.js";
import { type LaneReader, quietLaneChildWords, quietLaneJobWords, quietLaneSpawnWords } from "../quiet-lane-words.js";

/* What a parent reads about the quiet lane: a spawn's answer while it is in use, and a waited child's progress while its
   own command holds it, waits for it, or is held at its gate. */

const reader: LaneReader = { conversationId: "conv-lead", children: new Set(["sub-a", "sub-b", "sub-c"]) };

const run = (pid: number, conversation: string | undefined, seconds: number, label = "quiet"): LaneRun => ({ pid, conversation, label, seconds });

const lane = (over: Partial<QuietLane>): QuietLane => ({ holder: undefined, before: 0, waiting: [], held: [], ...over });

describe("the spawn answer", () => {
    test("says nothing while the lane is free, or only builds pass the gate", () => {
        expect(quietLaneSpawnWords(undefined, reader)).toBeUndefined();
        expect(quietLaneSpawnWords(lane({}), reader)).toBeUndefined();
        expect(quietLaneSpawnWords(lane({ held: [run(5, "sub-a", 3, "cargo")] }), reader)).toBeUndefined();
    });

    test("names who holds it and how many wait, counting the parent's own children", () => {
        const busy = lane({
            holder: run(1, "conv-other", 250),
            waiting: [run(2, "sub-a", 300), run(3, "conv-else", 200), run(4, "sub-b", 100)],
            held: [run(5, "sub-c", 30, "cargo"), run(6, "conv-else", 10, "vitest")],
        });
        expect(quietLaneSpawnWords(busy, reader)).toBe(
            "The quiet lane (one timed run at a time, sandbox-wide) is held by `conv-other` (`quiet`, 4m) and 3 runs wait for it, 2 of them from your own children; meanwhile 2 other heavy commands wait at its gate: children that time things will queue behind each other.",
        );
    });

    test("names the holder as the parent's own child, or the parent itself, and a run still waiting out the builds before it", () => {
        expect(quietLaneSpawnWords(lane({ holder: run(1, "sub-a", 40), before: 2, waiting: [run(2, "sub-b", 20)] }), reader)).toBe(
            "The quiet lane (one timed run at a time, sandbox-wide) is held by your child `sub-a` (`quiet`, 40s, still waiting out 2 heavy commands let in before it) and 1 run waits for it, from your own child: children that time things will queue behind each other.",
        );
        expect(quietLaneSpawnWords(lane({ holder: { ...run(1, "conv-lead", 5), label: undefined } }), reader)).toBe(
            "The quiet lane (one timed run at a time, sandbox-wide) is held by you (5s) and no run waits for it yet: children that time things will queue behind each other.",
        );
    });

    test("says when every run waiting is the parent's own", () => {
        expect(quietLaneSpawnWords(lane({ holder: run(1, "conv-other", 9), waiting: [run(2, "sub-a", 8), run(3, "sub-b", 7)] }), reader)).toContain(
            "and 2 runs wait for it, all from your own children:",
        );
    });

    test("still counts the waiting runs in the instant between two holders", () => {
        expect(quietLaneSpawnWords(lane({ waiting: [run(2, undefined, 20)] }), reader)).toBe(
            "The quiet lane (one timed run at a time, sandbox-wide) is between runs and 1 run waits for it: children that time things will queue behind each other.",
        );
    });
});

describe("a waited child's progress", () => {
    const busy = lane({
        holder: run(1, "sub-a", 250),
        before: 1,
        waiting: [run(2, "conv-else", 400), run(3, "sub-b", 300), run(4, "sub-b", 100)],
        held: [run(5, "sub-c", 30, "cargo"), run(6, "sub-c", 20, "cargo")],
    });

    test("says nothing for a child with no command in the lane, or a lane not read", () => {
        expect(quietLaneChildWords(busy, "sub-z", reader)).toBeUndefined();
        expect(quietLaneChildWords(undefined, "sub-a", reader)).toBeUndefined();
    });

    test("a child holding it, still waiting out what was let in before it", () => {
        expect(quietLaneChildWords(busy, "sub-a", reader)).toBe(
            "its command holds the quiet lane (`quiet`, 4m), still waiting out 1 heavy command let in before it; 3 runs wait behind it",
        );
    });

    test("a child whose timed run waits names the holder and its place by time waited", () => {
        expect(quietLaneChildWords(busy, "sub-b", reader)).toBe("its timed run waits for the quiet lane, held by your child `sub-a` (`quiet`, 4m): position 2 of 3");
    });

    test("a child whose builds are held at the gate until the holder ends", () => {
        expect(quietLaneChildWords(busy, "sub-c", reader)).toBe("2 heavy commands of its wait at the gate until the quiet lane's run by your child `sub-a` (`quiet`, 4m) ends");
        expect(quietLaneChildWords(lane({ holder: run(1, "conv-else", 30), held: [run(5, "sub-c", 3, "cargo")] }), "sub-c", reader)).toBe(
            "a heavy command of its waits at the gate until the quiet lane's run by `conv-else` (`quiet`, 30s) ends",
        );
    });
});

describe("a conversation's own job", () => {
    // The 2026-11-26 shinobi-society afternoon: a sibling's motion capture ran alone while three children's tests waited.
    const capture = lane({
        holder: run(90, "sub-a", 1500, "motion-capture"),
        held: [run(41, "conv-lead", 1320, "cargo-verify"), run(42, "conv-else", 1300, "cargo-verify")],
    });

    test("says nothing for a job with no process in the lane, or a lane not read", () => {
        expect(quietLaneJobWords(capture, new Set([7]), reader)).toBeUndefined();
        expect(quietLaneJobWords(undefined, new Set([41]), reader)).toBeUndefined();
    });

    test("a job held at the gate names who holds the lane, and that it starts only once that ends", () => {
        expect(quietLaneJobWords(capture, new Set([41]), reader)).toBe(
            "held 22m at the gate: nothing heavy starts while the lane is held by your child `sub-a` (`motion-capture`, 25m), which runs alone",
        );
    });

    test("a job running alone says what it holds off", () => {
        expect(quietLaneJobWords(capture, new Set([90]), reader)).toBe("it runs alone (`motion-capture`, 25m), and until it ends 2 heavy commands wait at the gate");
        expect(quietLaneJobWords(lane({ holder: run(90, "sub-a", 60, "motion-capture"), before: 3, waiting: [run(5, "conv-else", 30)] }), new Set([90]), reader)).toBe(
            "it runs alone (`motion-capture`, 60s), still waiting out 3 heavy commands let in before it, and until it ends 1 run waits for its own turn",
        );
        expect(quietLaneJobWords(lane({ holder: run(90, "conv-lead", 5) }), new Set([90]), reader)).toBe("it runs alone (`quiet`, 5s)");
    });

    test("a job waiting for its own turn to run alone names its place and the holder", () => {
        expect(quietLaneJobWords(lane({ holder: run(1, "conv-else", 30), waiting: [run(2, "sub-b", 50), run(3, "conv-lead", 20)] }), new Set([3]), reader)).toBe(
            "waiting 20s for its turn to run alone, position 2 of 2; the lane is held by `conv-else` (`quiet`, 30s)",
        );
    });
});
