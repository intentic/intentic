import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { describe, it, expect } from "bun:test";
import type { TurnCheckpoint, TurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import { agentToolChildren, type AgentTranscriptDeps, agentTranscriptPage, PAGE_TEXT_CAP } from "./agent-transcript.js";
import { fileTranscriptRecord, MAX_WINDOW_BYTES, transcriptFile } from "./transcript-record.js";

// Pins that a window's cost scales with the window, not the conversation's length. Assertions are on byte and row
// counts only; elapsed time is logged for visibility, never asserted, since CI timing is not deterministic.

// Byte budget a single conversation open must stay under.
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

// One turn as the record holds it: a user row, then one assistant row per prose block carrying its thinking and tool
// calls. Sized like a real working turn, not a minimal one.
const turnRows = (turn: number): TranscriptRow[] => [
    { role: "user", text: filler(180, `ask number ${turn}`), sentAt: 1_700_000_000_000 + turn * 60_000, messageId: `m-${turn}` },
    ...[0, 1, 2].map((block): TranscriptRow => ({
        role: "assistant",
        text: filler(700, `answer block ${block} of turn ${turn}`),
        thinking: filler(500, `reasoning ${block}/${turn}`),
        tools: [call(turn, block)],
        ...(block === 2 ? { usage: { costUsd: 0.03, inputTokens: 12_000, outputTokens: 900, durationMs: 21_000, numTurns: 1 } } : {}),
    })),
];

const ROWS_PER_TURN = turnRows(0).length;

// Appends one turn at a time, as turn settlement does, so the file matches what the daemon would write.
const write = async (root: string, conversationId: string, turns: number): Promise<void> => {
    const record = fileTranscriptRecord(root);
    for (let turn = 0; turn < turns; turn += 1) {
        await record.append(conversationId, turnRows(turn));
    }
};

const anchorsOf = (indices: readonly number[]): TurnCheckpoints => {
    const all = new Map<number, TurnCheckpoint>(indices.map((index) => [index, { kind: "tree", snapshot: `snap-${index}` }]));
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

// Runs the same read the route makes; every user row carries an anchor, as the real read stamps them.
const measure = async (root: string, conversationId: string, turns: number): Promise<Reading> => {
    const record = fileTranscriptRecord(root);
    const fileBytes = (await stat(transcriptFile(root, conversationId))).size;
    const deps = { record, turnCheckpoints: anchorsOf(Array.from({ length: turns }, (_, turn) => turn * ROWS_PER_TURN)) };
    const started = performance.now();
    const page = await agentTranscriptPage(deps, { id: conversationId });
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
    // No fan-out, no oversized tool result: length alone.
    it("answers a week of work within one open's budget", async () => {
        const root = await dir();
        const turns = 400;
        await write(root, "c-week", turns);

        const reading = await measure(root, "c-week", turns);
        report(`${turns} turns`, reading);

        expect(reading.payloadBytes).toBeLessThanOrEqual(OPEN_BUDGET_BYTES);
    });

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

    // rewindIndex is the message's absolute position in the whole record; the rewind route, fork and turn-checkpoints
    // checkpoints all address it directly.
    it("keeps rewind indices absolute, counted from the start of the record", async () => {
        const root = await dir();
        const turns = 100;
        await write(root, "c-anchors", turns);
        const record = fileTranscriptRecord(root);
        const userRows = Array.from({ length: turns }, (_, turn) => turn * ROWS_PER_TURN);
        const deps = { record, turnCheckpoints: anchorsOf(userRows) };

        const windowed = await agentTranscriptPage(deps, { id: "c-anchors" }, { turns: 5 });

        const stamped = windowed.rows.filter((row) => row.rewindIndex !== undefined);
        expect(stamped.length).toBe(5);
        expect(stamped.map((row) => row.rewindIndex)).toEqual([95, 96, 97, 98, 99].map((turn) => turn * ROWS_PER_TURN));
        expect(stamped.map((row) => row.checkpointId)).toEqual([95, 96, 97, 98, 99].map((turn) => `snap-${turn * ROWS_PER_TURN}`));
    });

    // `from` doubles as the next page's `before`.
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

    // Row ceiling wins over the turn boundary: the page splits inside the turn, and `more` reflects that.
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

    // Stale means a rewind or fork changed the record under the cursor; it degrades to the most recent window rather
    // than failing.
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

const agentOf = (id: string): { id: string; provider: "claude"; harness: "claude-code" } => ({ id, provider: "claude", harness: "claude-code" });

// A turn whose weight is all in one tool result: the shape turns and rows alone do not bound, since it is few rows of
// enormous size rather than many rows.
const dumpTurn = (turn: number, bytes: number): TranscriptRow[] => [
    { role: "user", text: `ask ${turn}` },
    { role: "assistant", text: `answer ${turn}`, tools: [{ ...call(turn, 0), content: [{ type: "text", text: filler(bytes, `dump ${turn}`) }] }] },
];

// A turn whose weight is in the answer itself, which no cap touches: what the byte budget is left to bound.
const proseTurn = (turn: number, bytes: number): TranscriptRow[] => [
    { role: "user", text: `ask ${turn}` },
    { role: "assistant", text: filler(bytes, `answer ${turn}`) },
];

const delegationTurn = (calls: number): TranscriptRow[] => [
    { role: "user", text: "delegate it" },
    {
        role: "assistant",
        text: "done",
        tools: [
            {
                id: "call_agent",
                name: "Agent",
                category: "other",
                status: "completed",
                children: Array.from({ length: calls }, (_, index) => call(0, index)),
            },
        ],
    },
];

const filled = async (conversationId: string, turns: readonly TranscriptRow[][]): Promise<{ root: string; deps: AgentTranscriptDeps }> => {
    const root = await dir();
    const record = fileTranscriptRecord(root);
    for (const rows of turns) {
        await record.append(conversationId, rows);
    }
    return { root, deps: { record, turnCheckpoints: anchorsOf([]) } };
};

const servedBytes = (page: { readonly rows: readonly TranscriptRow[] }): number => Buffer.byteLength(JSON.stringify(page.rows));

// Length of the last row's first tool result, or -1 where there is none; a flat number keeps the assertion readable.
const lastToolOutput = (rows: readonly TranscriptRow[]): number => {
    const entry = rows.at(-1)?.tools?.[0]?.content?.[0];
    return entry?.type === "text" ? entry.text.length : -1;
};

describe("what a page carries of a heavy turn", () => {
    // Turns and rows measure the wrong thing: a conversation of four turns can be tens of megabytes.
    it("stops on the byte budget when the turn count would not", async () => {
        const { deps } = await filled(
            "c-prose",
            Array.from({ length: 12 }, (_, turn) => proseTurn(turn, 400_000)),
        );

        const page = await agentTranscriptPage(deps, agentOf("c-prose"));

        expect(servedBytes(page)).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
        expect(page.rows.filter((row) => row.role === "user").length).toBeLessThan(12);
        expect(page.more).toBe(true);
    });

    // Withholding it would leave the chat with nothing at all, which is worse than one slow open. The budget splits the
    // turn the same way the row ceiling already does, and `more` puts the question above it one press away.
    it("serves a single row larger than the whole budget rather than nothing", async () => {
        const { deps } = await filled("c-onebig", [proseTurn(0, MAX_WINDOW_BYTES * 2)]);

        const page = await agentTranscriptPage(deps, agentOf("c-onebig"));

        expect(page.rows.length).toBe(1);
        expect(servedBytes(page)).toBeGreaterThan(MAX_WINDOW_BYTES);
        expect(page.from).toBe(1);
        expect(page.more).toBe(true);
    });

    // The budget is spent on what goes out. Measured against the stored line instead, a conversation of tool dumps
    // would open on two turns despite shipping a few kilobytes.
    it("spends the budget on the served page, not the stored record", async () => {
        const { root, deps } = await filled(
            "c-dumps",
            Array.from({ length: 20 }, (_, turn) => dumpTurn(turn, 500_000)),
        );

        const page = await agentTranscriptPage(deps, agentOf("c-dumps"));

        expect((await stat(transcriptFile(root, "c-dumps"))).size).toBeGreaterThan(9_000_000);
        expect(page.rows.filter((row) => row.role === "user").length).toBe(20);
        expect(servedBytes(page)).toBeLessThan(MAX_WINDOW_BYTES);
    });

    // The pane draws 4000 characters of a tool result (toolPresentation.ts TEXT_CAP); the rest was shipped to be thrown
    // away. The record keeps it, for a handoff, a share or a recall.
    it("caps a tool's output at what the pane draws, and leaves the record whole", async () => {
        const { root, deps } = await filled("c-dump", [dumpTurn(0, 500_000)]);

        const page = await agentTranscriptPage(deps, agentOf("c-dump"));

        expect(lastToolOutput(page.rows)).toBe(PAGE_TEXT_CAP);
        expect(lastToolOutput(await fileTranscriptRecord(root).read("c-dump"))).toBe(500_000);
    });
});

describe("a delegation's own calls", () => {
    it("are counted on the page, not carried", async () => {
        const { root, deps } = await filled("c-deleg", [delegationTurn(40)]);

        const page = await agentTranscriptPage(deps, agentOf("c-deleg"));
        const card = page.rows.at(-1)?.tools?.[0];

        expect(card?.children).toBeUndefined();
        expect(card?.nested).toBe(40);
        expect((await fileTranscriptRecord(root).read("c-deleg")).at(-1)?.tools?.[0]?.children).toHaveLength(40);
    });

    it("come back whole on the press that opens the card", async () => {
        const { deps } = await filled("c-open", [delegationTurn(40)]);

        const children = await agentToolChildren(deps, agentOf("c-open"), "call_agent");

        expect(children).toHaveLength(40);
        expect(children[0]?.id).toBe("call_0_0");
    });

    // A child that delegated in turn: the lookup has to descend, since only the top card is addressed by the page.
    it("reach a call nested under another delegation", async () => {
        const inner: TranscriptTool = { id: "call_inner", name: "Agent", category: "other", status: "completed", children: [call(9, 9)] };
        const { deps } = await filled("c-deep", [
            [
                { role: "user", text: "delegate deeply" },
                {
                    role: "assistant",
                    text: "done",
                    tools: [{ id: "call_outer", name: "Agent", category: "other", status: "completed", children: [inner] }],
                },
            ],
        ]);

        expect(await agentToolChildren(deps, agentOf("c-deep"), "call_inner")).toEqual([call(9, 9)]);
        expect(await agentToolChildren(deps, agentOf("c-deep"), "call_missing")).toEqual([]);
    });
});
