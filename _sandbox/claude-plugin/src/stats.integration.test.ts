import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_ARM_TURNS } from "@intentic/agent-context/arm-stats";
import { readOptions, saveOptions } from "./features.js";
import { outputDir } from "./post-bash.js";
import { recordSession, type SessionRow } from "./sessions.js";
import { parseStatsArgs, statsReport } from "./stats.js";

// The report end to end: ledger rows and recorded sessions in a data directory, transcripts on disk, and the lines a
// person reads. The arithmetic itself is pinned where it lives (@intentic/output-cleaners, @intentic/agent-context).

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "intentic-stats-"));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const PROJECT = "/src/app";

// One session whose opening turn runs the given commands, as Claude Code would have filed it.
const transcript = (dir: string, id: string, commands: readonly string[]): string => {
    const at = (second: number): string => new Date(Date.UTC(2026, 8, 1, 12, 0, second)).toISOString();
    const lines = [
        JSON.stringify({ type: "user", sessionId: id, timestamp: at(0), message: { role: "user", content: "fix the parser" } }),
        ...commands.map((command, index) =>
            JSON.stringify({
                type: "assistant",
                sessionId: id,
                timestamp: at(index + 1),
                message: { content: [{ type: "tool_use", id: `${id}-${index}`, name: "Bash", input: { command } }] },
            }),
        ),
    ];
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
};

const session = (data: string, dir: string, id: string, map: boolean, commands: readonly string[]): void => {
    const row: SessionRow = { ts: 1, session: id, project: PROJECT, transcript: transcript(dir, id, commands), arms: { map }, sent: map ? { map: 900 } : {} };
    recordSession(data, row);
};

test("the cleaners' saving, and a measured mechanism's effect with its margin", () => {
    const data = tempDir();
    const transcripts = tempDir();
    mkdirSync(outputDir(data), { recursive: true });
    writeFileSync(
        join(outputDir(data), "filter-stats.jsonl"),
        [
            { project: PROJECT, command: "pnpm install", rawBytes: 40_000, emittedBytes: 4000, matched: ["pnpm"], heldOut: false, stageBytes: { pnpm: 36_000 } },
            { project: "/elsewhere", command: "ls", rawBytes: 4000, emittedBytes: 4000, matched: [], heldOut: false, stageBytes: {} },
        ]
            .map((row) => JSON.stringify(row))
            .join("\n"),
    );
    // Sessions given the map open straight into a search; held-out ones list the root first, one or two times.
    for (let index = 0; index < MIN_ARM_TURNS + 5; index += 1) {
        session(data, transcripts, `on-${index}`, true, ["rg parse src"]);
        session(data, transcripts, `off-${index}`, false, index % 2 === 0 ? ["ls", "rg parse src"] : ["ls", "ls -la", "rg parse src"]);
    }
    const report = statsReport({ data, project: PROJECT, options: readOptions({}) });
    expect(report).toContain("1 command trimmed: 10k tokens of output became 1.0k (90% saved, exact per command).");
    expect(report).toContain("Biggest cleaners: pnpm 9.0k (1 command).");
    expect(report).toContain(`${2 * (MIN_ARM_TURNS + 5)} recorded sessions`);
    expect(report).toMatch(/Project map, root listings in the opening turn: -100% ±\d+(\.\d)?pp \(95%\): 0 with it vs 1\.5 without, over 35 and 35 opening turns\./);
});

test("a mechanism that is off, or measured by nobody, says which", () => {
    const data = tempDir();
    const report = statsReport({ data, project: PROJECT, options: readOptions({ CLAUDE_PLUGIN_OPTION_FIELD_NOTES: "false", CLAUDE_PLUGIN_OPTION_HOLDOUT: "0" }) });
    expect(report).toContain("No commands have been trimmed yet.");
    expect(report).toContain("Field notes: switched off.");
    expect(report).toContain("Project map: on for every session; nothing is held out (`holdout` is 0), so there is nothing to compare.");
});

test("the report's switches are the ones the last session opened with, and a flag overrides one", () => {
    const data = tempDir();
    expect(parseStatsArgs(["--data", data, "--project", "/p"]).options).toEqual(readOptions({}));
    saveOptions(data, readOptions({ CLAUDE_PLUGIN_OPTION_FIELD_NOTES: "false", CLAUDE_PLUGIN_OPTION_CLEANERS: "-cap,-wide", CLAUDE_PLUGIN_OPTION_HOLDOUT: "0.2" }));
    const args = parseStatsArgs(["--data", data, "--project", "/p", "--option", "holdout=0.3"]);
    expect(args).toMatchObject({ data, project: "/p" });
    expect(args.options).toMatchObject({ field_notes: false, cleaners: "-cap,-wide", holdout: 0.3, iq: true });
    expect(parseStatsArgs(["--data", data, "--project", "/p", "all"]).project).toBeUndefined();
});
