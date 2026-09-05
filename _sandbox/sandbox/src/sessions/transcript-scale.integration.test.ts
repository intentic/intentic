import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import type { TurnAnchor, TurnAnchors } from "../agent/turn-anchors.js";
import { agentTranscriptPage } from "./agent-transcript.js";
import { fileTranscriptRecord } from "./transcript-record.js";

/* WHAT OPENING A CONVERSATION IS ALLOWED TO COST, and what the window may not break to keep it there.
 *
 * `GET /agents/{id}/transcript` used to answer with the whole record: the file split whole, Zod-parsed row by
 * row, and rendered row by row by a chat that virtualizes nothing. Measured here at 400 turns, that was 1600
 * rows and 3.74 MB down a tunnel to redraw a screenful — and paid again for each of the forty cards the
 * board's warm loader reads ahead (composables/prefetch/sources/agentsWarm.ts), before anybody clicks
 * anything. The same fixture through the window is 80 rows and 0.19 MB, and costs the same at 4000 turns as
 * at 40.
 *
 * The first two tests hold that bound. The rest hold the things a window is liable to get wrong: opening
 * mid-turn, renumbering the rewind indices it hands back, losing a row at a page seam, letting one fanned-out
 * turn serve the whole conversation, and failing an open over a cursor that went stale.
 *
 * Every assertion is on BYTES and ROW COUNTS, which are deterministic; elapsed milliseconds are printed as
 * diagnostics and never asserted, because a shared CI box is not a stopwatch. */

/* What one open may put on the wire. The order of magnitude the two comparable harnesses settled on:
 * deepseek-harness pages history in 200-message windows, t3code windows by user turn under a 150-raw-turn
 * page ceiling. Either lands a first paint in the low hundreds of KB; a megabyte is the generous end of it. */
const OPEN_BUDGET_BYTES = 1_000_000;

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "transcript-scale-"));

const filler = (length: number, seed: string): string => {
    const unit = `${seed} `;
    return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
};

const call = (turn: number, index: number): TranscriptTool => ({
    id: `call_${turn}_${index}`,
    name: index % 2 === 0 ? "Read" : "Edit",
    category: index % 2 === 0 ? "read" : "edit",
    status: "completed",
    target: `_sandbox/sandbox/src/sessions/module-${index}.ts`,
    locations: [{ path: `_sandbox/sandbox/src/sessions/module-${index}.ts`, line: turn }],
    content: [{ type: "text", text: filler(1_500, `tool output for call ${turn}/${index}`) }],
});

/* ONE TURN AS THE RECORD ACTUALLY HOLDS IT: the user's message, then a row per block of the agent's prose,
 * each carrying that block's thinking and the tool cards it introduced. Sized off what a working turn looks
 * like rather than off a minimal row, because the question here is what a real conversation weighs. */
const turnRows = (turn: number): TranscriptRow[] => [
    { role: "user", text: filler(180, `ask number ${turn}`), sentAt: 1_700_000_000_000 + turn * 60_000 },
    ...[0, 1, 2].map(
        (block): TranscriptRow => ({
            role: "assistant",
            text: filler(700, `answer block ${block} of turn ${turn}`),
            thinking: filler(500, `reasoning ${block}/${turn}`),
            tools: [call(turn, block)],
            ...(block === 2 ? { usage: { costUsd: 0.03, inputTokens: 12_000, outputTokens: 900, durationMs: 21_000, numTurns: 1 } } : {}),
        }),
    ),
];

const ROWS_PER_TURN = turnRows(0).length;

// Appended a turn at a time, exactly as turn settlement does, so the file on disk is the file the daemon
// would have written.
const write = async (root: string, conversationId: string, turns: number): Promise<void> => {
    const record = fileTranscriptRecord(root);
    for (let turn = 0; turn < turns; turn += 1) {
        await record.append(conversationId, turnRows(turn));
    }
};

const anchorsOf = (indices: readonly number[]): TurnAnchors => {
    const all = new Map<number, TurnAnchor>(indices.map((index) => [index, { kind: "tree", snapshot: `snap-${index}` }]));
    return {
        record: () => Promise.resolve(),
        of: (_id, index) => Promise.resolve(all.get(index)),
        all: () => Promise.resolve(all),
        truncate: () => Promise.resolve(),
    };
};

interface Reading {
    readonly rows: number;
    readonly fileBytes: number;
    readonly payloadBytes: number;
    readonly readMs: number;
}

// The read the route makes, measured. Every user row carries an anchor, which is what the real read stamps.
const measure = async (root: string, conversationId: string, turns: number): Promise<Reading> => {
    const record = fileTranscriptRecord(root);
    const fileBytes = (await stat(join(root, `${conversationId}.jsonl`))).size;
    const deps = { record, turnAnchors: anchorsOf(Array.from({ length: turns }, (_, turn) => turn * ROWS_PER_TURN)) };
    const started = performance.now();
    const page = await agentTranscriptPage(deps, { id: conversationId, provider: "claude", harness: "claude-code" });
    const readMs = performance.now() - started;
    return { rows: page.rows.length, fileBytes, payloadBytes: Buffer.byteLength(JSON.stringify(page)), readMs };
};

const report = (label: string, reading: Reading): void => {
    const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(2)} MB`;
    // eslint-disable-next-line no-console -- the measurement is this suite's deliverable.
    console.log(
        `[transcript-scale] ${label}: ${reading.rows} rows · file ${mb(reading.fileBytes)} · payload ${mb(reading.payloadBytes)} · read ${reading.readMs.toFixed(0)} ms`,
    );
};

describe("opening a long conversation", () => {
    /* A conversation that ran for a week at a few dozen turns a day. Nothing pathological: no fan-out, no
     * megabyte tool result, just length. */
    it("answers a week of work within one open's budget", async () => {
        const root = await dir();
        const turns = 400;
        await write(root, "c-week", turns);

        const reading = await measure(root, "c-week", turns);
        report(`${turns} turns`, reading);

        expect(reading.payloadBytes).toBeLessThanOrEqual(OPEN_BUDGET_BYTES);
    });

    /* THE SHAPE OF THE COST, which is the part that cannot be fixed by making rows smaller: what the read
     * returns must be bounded by the WINDOW, not by how long the user has been working. Ten times the
     * conversation must not be ten times the answer. */
    it("returns a window, not a conversation: ten times the history is not ten times the read", async () => {
        const root = await dir();
        await write(root, "c-short", 40);
        await write(root, "c-tenfold", 400);

        const short = await measure(root, "c-short", 40);
        const long = await measure(root, "c-tenfold", 400);
        report(`40 turns`, short);
        report(`400 turns`, long);

        expect(long.rows).toBeLessThanOrEqual(short.rows * 2);
    });

    // A conversation shorter than the window is returned whole, and says so: nothing to page back to.
    it("hands back a short conversation whole", async () => {
        const root = await dir();
        await write(root, "c-brief", 3);
        const record = fileTranscriptRecord(root);

        const page = await record.window("c-brief", {});

        expect(page.rows.length).toBe(3 * ROWS_PER_TURN);
        expect(page.from).toBe(0);
        expect(page.more).toBe(false);
    });
});

describe("the transcript window", () => {
    /* A WINDOW OPENS ON A QUESTION. Cutting at a fixed row count would routinely open a chat on an answer
     * whose question is above the fold, which reads as the agent talking to itself; so the window is measured
     * in user turns and always starts at one. */
    it("starts at a user message, never mid-turn", async () => {
        const root = await dir();
        await write(root, "c-turns", 100);
        const record = fileTranscriptRecord(root);

        const page = await record.window("c-turns", { turns: 5 });

        expect(page.rows[0]?.role).toBe("user");
        expect(page.rows.filter((row) => row.role === "user").length).toBe(5);
        expect(page.from).toBe(95 * ROWS_PER_TURN);
        expect(page.more).toBe(true);
    });

    /* THE SHARP EDGE THE WINDOW INTRODUCES. `rewindIndex` is a message's position in the WHOLE record: it is
     * what the rewind route addresses, what a fork counts to, and what turn-anchors files a checkpoint under
     * (transcript-record.ts's `count`/`truncate`, agents.routes' rewind). A window that renumbered its rows
     * from zero would hand the client indices that address a different message than the one on screen —
     * rewinding turn 396 by clicking turn 6. The window slides; these numbers must not. */
    it("keeps rewind indices absolute, counted from the start of the record", async () => {
        const root = await dir();
        const turns = 100;
        await write(root, "c-anchors", turns);
        const record = fileTranscriptRecord(root);
        const userRows = Array.from({ length: turns }, (_, turn) => turn * ROWS_PER_TURN);
        const deps = { record, turnAnchors: anchorsOf(userRows) };

        const windowed = await agentTranscriptPage(deps, { id: "c-anchors", provider: "claude", harness: "claude-code" }, { turns: 5 });

        const stamped = windowed.rows.filter((row) => row.rewindIndex !== undefined);
        expect(stamped.length).toBe(5);
        expect(stamped.map((row) => row.rewindIndex)).toEqual([95, 96, 97, 98, 99].map((turn) => turn * ROWS_PER_TURN));
        expect(stamped.map((row) => row.checkpointId)).toEqual([95, 96, 97, 98, 99].map((turn) => `snap-${turn * ROWS_PER_TURN}`));
    });

    /* PAGING BACK REACHES THE BEGINNING, and covers the record exactly once: every row, in order, no gap at a
     * page seam and no row served twice. `from` is the next page's `before`, which is the whole cursor. */
    it("pages back through the whole record without a gap or a repeat", async () => {
        const root = await dir();
        const turns = 47;
        await write(root, "c-pages", turns);
        const record = fileTranscriptRecord(root);

        const collected: TranscriptRow[] = [];
        let before: number | undefined;
        let pages = 0;
        for (;;) {
            const page = await record.window("c-pages", { turns: 6, ...(before === undefined ? {} : { before }) });
            collected.unshift(...page.rows);
            pages += 1;
            if (!page.more) {
                expect(page.from).toBe(0);
                break;
            }
            before = page.from;
            expect(pages).toBeLessThan(20);
        }

        expect(pages).toBe(Math.ceil(turns / 6));
        expect(collected.length).toBe(turns * ROWS_PER_TURN);
        expect(collected.map((row) => row.text)).toEqual((await record.read("c-pages")).map((row) => row.text));
    });

    /* ONE TURN MUST NOT BE ABLE TO BLOW THE WINDOW. A turn that fans out into hundreds of rows (a delegation,
     * a long agentic loop) would otherwise defeat a turn-counted window entirely, which is why t3code puts a
     * raw-row ceiling beside its turn limit. When the ceiling bites it WINS over the user-row boundary: the
     * page splits inside the turn, and `more` says so, so the rest of that turn is one page back rather than
     * a megabyte the client did not ask for. */
    it("bounds a single fanned-out turn by rows, not just by turns", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c-fanout", [
            { role: "user", text: "go" },
            ...Array.from({ length: 900 }, (_, index): TranscriptRow => ({ role: "assistant", text: `step ${index}`, tools: [call(0, index)] })),
        ]);

        const page = await record.window("c-fanout", { turns: 5, maxRows: 400 });

        expect(page.rows.length).toBeLessThanOrEqual(400);
        expect(page.rows[0]?.role).toBe("assistant");
        expect(page.more).toBe(true);
        expect(page.from).toBeGreaterThan(0);
    });

    /* A CURSOR IS NEVER AN ERROR. A client's `before` can be stale by the time it arrives — a rewind truncated
     * the record under it, a fork re-cut it, the tab slept through both. t3code's rule, for the same reason:
     * degrade to "the most recent window" rather than failing an open. */
    it("clamps a stale or nonsensical cursor instead of refusing to answer", async () => {
        const root = await dir();
        await write(root, "c-stale", 10);
        const record = fileTranscriptRecord(root);
        const whole = 10 * ROWS_PER_TURN;

        const past = await record.window("c-stale", { before: whole + 5_000, turns: 3 });
        expect(past.rows.length).toBe(3 * ROWS_PER_TURN);
        expect(past.from).toBe(whole - 3 * ROWS_PER_TURN);

        const negative = await record.window("c-stale", { before: -7, turns: 3 });
        expect(negative.rows).toEqual([]);
        expect(negative.from).toBe(0);
        expect(negative.more).toBe(false);

        const fractional = await record.window("c-stale", { before: 12.7, turns: 99 });
        expect(fractional.rows.length).toBe(12);
        expect(fractional.from).toBe(0);
    });
});
