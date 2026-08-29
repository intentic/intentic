import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { guidanceStats } from "./guidance-corpus.js";

/* THE THREE WAYS THIS PARSER WAS WRONG BEFORE ANYONE READ ITS OUTPUT, each one now a test.
 *
 * A statistics tool fails quietly: it prints a plausible number and nothing crashes. Every case here comes from
 * a wrong figure the first version actually reported, and each stayed invisible until the figure was compared
 * against a value computed a different way. Fixtures are hand-written rather than captured, so the expected
 * answer is arithmetic rather than a snapshot of whatever the parser happened to do. */

let dir: string | undefined;
afterEach(() => {
    if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    }
});

let clock = 0;
const at = (): string => new Date(1_700_000_000_000 + (clock += 1000)).toISOString();

// One assistant line per tool_use, which is how the CLI writes them: several blocks of ONE response arrive as
// several lines sharing a requestId. A fixture that put them in one line would test a format that never occurs.
const asks = (requestId: string, calls: { id: string; name: string; input?: Record<string, unknown> }[]): string[] =>
    calls.map((call) =>
        JSON.stringify({
            type: "assistant",
            requestId,
            timestamp: at(),
            message: { model: "test-model", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} }] },
        }),
    );

const answers = (results: { id: string; text: string; isError?: boolean }[]): string =>
    JSON.stringify({
        type: "user",
        timestamp: at(),
        message: { content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, is_error: r.isError ?? false })) },
    });

const corpusOf = (sessions: string[][]): string => {
    dir = mkdtempSync(join(tmpdir(), "guidance-stats-"));
    const project = join(dir, "-work");
    mkdirSync(project);
    sessions.forEach((lines, index) => writeFileSync(join(project, `session-${index}.jsonl`), `${lines.join("\n")}\n`));
    return dir;
};

/* Response indices restart at 0 in every session, so they identify a response only WITHIN a file. Counting them
 * in one corpus-wide map merged every session's response 0 into a single key and reported 103 calls per
 * response against a true 1.16. Two sessions is the smallest corpus that can catch it. */
test("counts responses per session rather than merging identical indices across files", () => {
    const session = (): string[] => [...asks("r1", [{ id: "a", name: "Read" }]), answers([{ id: "a", text: "x" }])];
    const stats = guidanceStats(corpusOf([session(), session()]));

    expect(stats.corpus.calls).toBe(2);
    expect(stats.corpus.responses).toBe(2);
    expect(stats.BATCHING_GUIDANCE.callsPerResponse).toBe("1.00");
    expect(stats.BATCHING_GUIDANCE.singleCall).toBe("100.0%");
});

// A batched response is several tool_use lines under ONE requestId. Counting lines instead of requestIds made
// every response in the corpus look single-call, which is the exact figure the guidance block is arguing about.
test("a batch of three under one requestId is one response, not three", () => {
    const stats = guidanceStats(
        corpusOf([
            [
                ...asks("r1", [
                    { id: "a", name: "Read" },
                    { id: "b", name: "Read" },
                    { id: "c", name: "Read" },
                ]),
                answers([
                    { id: "a", text: "x" },
                    { id: "b", text: "y" },
                    { id: "c", text: "z" },
                ]),
            ],
        ]),
    );

    expect(stats.corpus.calls).toBe(3);
    expect(stats.corpus.responses).toBe(1);
    expect(stats.BATCHING_GUIDANCE.callsPerResponse).toBe("3.00");
    expect(stats.BATCHING_GUIDANCE.singleCall).toBe("0.0%");
});

/* A response was judged as the NEXT call arrived, which tested the previous response's size against the next
 * response's tool name. Here the run of single Reads is broken by a single Edit: the Edit must end the run, and
 * with the old ordering it was the Edit's own arrival that decided whether the Read before it was orienting. */
test("an orienting run is the consecutive single-call reads, and a write ends it", () => {
    const read = (n: number): string[] => [...asks(`r${n}`, [{ id: `a${n}`, name: "Read", input: { file_path: `/f${n}.ts` } }]), answers([{ id: `a${n}`, text: "x" }])];
    const stats = guidanceStats(
        corpusOf([
            [
                ...read(1),
                ...read(2),
                ...read(3),
                ...asks("r4", [{ id: "w", name: "Edit", input: { file_path: "/f1.ts" } }]),
                answers([{ id: "w", text: "ok" }]),
                // Two more reads: a run of two, under the three it takes to count.
                ...read(5),
                ...read(6),
            ],
        ]),
    );

    expect(stats.BATCHING_GUIDANCE.callsInOrientingRuns).toBe(3);
});

// A re-read is only the waste the guidance names when it re-reads what an Edit already handed back. Reading a
// DIFFERENT part of a file this session edited is ordinary work, and counting it inflated the bucket 3x.
test("separates a confirming read-back from paging elsewhere in an edited file", () => {
    const edit = (id: string, path: string): string[] => [
        JSON.stringify({
            type: "assistant",
            requestId: id,
            timestamp: at(),
            message: { model: "test-model", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: path } }] },
        }),
        JSON.stringify({
            type: "user",
            timestamp: at(),
            toolUseResult: { structuredPatch: [{ newStart: 100, newLines: 10 }] },
            message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
        }),
    ];
    const readRange = (id: string, path: string, offset: number): string[] => [
        ...asks(id, [{ id, name: "Read", input: { file_path: path, offset, limit: 20 } }]),
        answers([{ id, text: "some file content" }]),
    ];

    const stats = guidanceStats(
        corpusOf([
            [
                ...readRange("first", "/a.ts", 1),
                ...edit("e1", "/a.ts"),
                ...readRange("back", "/a.ts", 100), // overlaps the patched hunk: the confirming read-back
                ...readRange("firstb", "/b.ts", 1),
                ...edit("e2", "/b.ts"),
                ...readRange("away", "/b.ts", 500), // nowhere near it: ordinary work
            ],
        ]),
    );

    expect(stats.CONTEXT_REUSE_GUIDANCE.breakdown).toEqual({
        "ranged read OVERLAPPING our edit": 1,
        "ranged read elsewhere in the file": 1,
    });
    expect(stats.CONTEXT_REUSE_GUIDANCE.confirmingReadBacks).toMatch(/^1 calls/);
});

// A transcript is somebody else's file. One unparseable line, or one shape from a CLI version that predates a
// field, must cost that line and nothing else: the alternative is a corpus that silently reports zero.
test("skips junk lines and calls whose result never arrived", () => {
    const stats = guidanceStats(
        corpusOf([
            [
                "not json at all",
                JSON.stringify({ type: "assistant", requestId: "r0", message: { content: "a plain string, not blocks" } }),
                ...asks("r1", [{ id: "orphan", name: "Read" }]), // no result: the turn was killed
                ...asks("r2", [{ id: "ok", name: "Bash", input: { command: "echo hi" } }]),
                answers([{ id: "ok", text: "hi" }]),
            ],
        ]),
    );

    expect(stats.corpus.calls).toBe(1);
    expect(stats.SEARCH_GUIDANCE.bashCalls).toBe(1);
});
