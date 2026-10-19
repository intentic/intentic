import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { TurnRun } from "../agent/run/turn/turn-runs.js";
import { openRunLog, readRunLog, removeRunLog, unrecordedRuns } from "./run-log.js";

// A running turn's rows written as they are drawn, and read back after a death as the rows a window was showing.

const opening: TranscriptRow[] = [{ role: "user", text: "port the parser", sentAt: 1 }];

// A run whose every patch goes to a log in `dir`, as startTurnRun wires a journalled one; flushed by hand here.
const loggedRun = (dir: string, id = "run-1") => {
    const run = new TurnRun(opening, 1, id);
    const warned: string[] = [];
    const log = openRunLog(dir, { run: run.id, startedAt: run.startedAt, rows: [...run.rows] }, (message) => warned.push(message), 60_000);
    run.tap = log.append;
    return { run, log, warned };
};

const working: AgentEvent[] = [
    { kind: "delta", text: "Reading " },
    { kind: "delta", text: "the parser." },
    { kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
    { kind: "tool_call_update", id: "t1", status: "in_progress", content: [{ type: "text", text: "1 passed" }] },
    { kind: "tool_call_update", id: "t1", status: "completed", content: [{ type: "text", text: "12 passed" }] },
    { kind: "steer", text: "also fix the README", sentAt: 2, messageId: "m-2" },
    { kind: "delta", text: "On it." },
];

const unit = (): Promise<string> => mkdtemp(join(tmpdir(), "run-log-"));

describe("a run's log", () => {
    it("reads back exactly the rows the live run drew, whatever runtime drew them", async () => {
        const dir = await unit();
        const { run, log } = loggedRun(dir);
        for (const event of working) {
            run.push(event);
        }
        await log.flush();
        expect((await readRunLog(dir, run.id))?.rows).toEqual([...run.rows]);
        await log.close(true);
    });

    // A streaming command would otherwise write its whole output again on every flush.
    it("logs a running card without its output, and the output it settles with whole", async () => {
        const dir = await unit();
        const { run, log } = loggedRun(dir);
        run.push({ kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" });
        run.push({ kind: "tool_call_update", id: "t1", status: "in_progress", content: [{ type: "text", text: "partial" }] });
        await log.flush();
        expect((await readRunLog(dir, run.id))?.rows.at(-1)?.tools?.[0]).not.toHaveProperty("content");
        run.push({ kind: "tool_call_update", id: "t1", status: "completed", content: [{ type: "text", text: "done" }] });
        await log.flush();
        expect((await readRunLog(dir, run.id))?.rows.at(-1)?.tools?.[0]).toMatchObject({ status: "completed", content: [{ type: "text", text: "done" }] });
        await log.close(true);
    });

    it("stops at a line a crash cut mid-write, keeping everything before it", async () => {
        const dir = await unit();
        const { run, log } = loggedRun(dir);
        run.push({ kind: "delta", text: "Reading the parser." });
        await log.flush();
        const kept = [...run.rows];
        const file = join(dir, "running.jsonl");
        await writeFile(file, `${await readFile(file, "utf8")}{"op":"text","ind`);
        expect((await readRunLog(dir, run.id))?.rows).toEqual(kept);
        await log.close(true);
    });

    it("answers only for the run it names: another run's log is not this one's", async () => {
        const dir = await unit();
        const { log } = loggedRun(dir, "run-1");
        await log.flush();
        expect(await readRunLog(dir, "run-2")).toBeUndefined();
        expect(await readRunLog(dir, undefined)).toBeUndefined();
        await removeRunLog(dir, "run-2");
        expect(await readRunLog(dir, "run-1")).toMatchObject({ run: "run-1" });
        await removeRunLog(dir, "run-1");
        expect(await readRunLog(dir, "run-1")).toBeUndefined();
        await log.close(true);
    });

    it("goes once the record takes the turn", async () => {
        const dir = await unit();
        const { run, log } = loggedRun(dir);
        run.push({ kind: "delta", text: "done" });
        await log.close(true);
        expect(await readdir(dir)).toEqual([]);
    });

    // The record refused the settled rows: whoever writes this conversation's record next writes them first.
    it("is kept under its run's name when the record refused the turn, oldest first among those", async () => {
        const dir = await unit();
        const first = loggedRun(dir, "run-a");
        first.run.push({ kind: "delta", text: "first" });
        await first.log.close(false);
        const second = loggedRun(dir, "run-b");
        second.run.push({ kind: "delta", text: "second" });
        await second.log.close(false);
        const kept = await unrecordedRuns(dir);
        expect(kept.map(({ head }) => [head.run, head.rows.at(-1)?.text])).toEqual([
            ["run-a", "first"],
            ["run-b", "second"],
        ]);
        await kept[0]?.remove();
        expect((await unrecordedRuns(dir)).map(({ head }) => head.run)).toEqual(["run-b"]);
    });

    it("says a write it could not make once, and the run goes on unlogged", async () => {
        const dir = join(await unit(), "file-not-dir");
        await writeFile(dir, "");
        const { run, log, warned } = loggedRun(dir);
        run.push({ kind: "delta", text: "still runs" });
        await log.close(true);
        expect(warned).toHaveLength(1);
        expect(run.rows.at(-1)?.text).toBe("still runs");
    });
});
