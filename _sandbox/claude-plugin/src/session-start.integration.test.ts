import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentArm } from "@intentic/agent-context/experiments";
import { loadOptions } from "./features.js";
import { fieldNotesFile } from "./hook-io.js";
import { readSessions, SALTS } from "./sessions.js";
import { sessionStart } from "./session-start.js";

// SessionStart against a real project tree and data directory: what a new session is told, what a held-out one is not,
// what is recorded for the stats, and the sessions that must not be told twice.

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "intentic-session-start-"));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A project with areas worth mapping, and field notes to send.
const project = (): string => {
    const root = tempDir();
    for (const [path, content] of Object.entries({
        "api/package.json": JSON.stringify({ name: "api", description: "The HTTP API" }),
        "api/src/server.ts": "export {};\n",
        "web/package.json": JSON.stringify({ name: "web", description: "The browser app" }),
        "web/src/app.ts": "export {};\n",
        "web/src/view.ts": "export {};\n",
    })) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    mkdirSync(join(fieldNotesFile(root), ".."), { recursive: true });
    writeFileSync(
        fieldNotesFile(root),
        ["meta:", "  title: Field notes", "priority[1]{rank,id,title,cost}:", "  1,verify,What verifies,a passing run that proved nothing", "verify:", "  tests: run pnpm test:int for the API", ""].join("\n"),
    );
    return root;
};

// PATH without iq, so the iq switch has nothing to teach.
const baseEnv = (data: string, root: string): Record<string, string> => ({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: root, PATH: tempDir() });

type Answer = { systemMessage?: string; hookSpecificOutput: { additionalContext?: string } } | undefined;

test("a new session is told the map and the field notes, and its arms are recorded for the stats", () => {
    const root = project();
    const data = tempDir();
    const answer = sessionStart({ session_id: "s-1", source: "startup", cwd: root, transcript_path: "/t/s-1.jsonl" }, { ...baseEnv(data, root), CLAUDE_PLUGIN_OPTION_HOLDOUT: "0" }) as Answer;
    const context = answer?.hookSpecificOutput.additionalContext ?? "";
    expect(context).toContain("## Map of this project");
    expect(context).toContain("use Glob or Read for exact paths");
    expect(context).toContain("The browser app");
    expect(context).toContain("## Field notes for this project");
    expect(context).toContain("tests: run pnpm test:int for the API");
    const [row] = readSessions(data);
    expect(row).toMatchObject({ session: "s-1", project: root, transcript: "/t/s-1.jsonl", arms: {} });
    expect(row?.sent.map).toBe(context.indexOf("## Field notes") - 2);
});

test("a held-out session is told nothing it was drawn out of, and says so in its row", () => {
    const root = project();
    const data = tempDir();
    // An id every experiment holds out at this share, found rather than transcribed.
    const held = Array.from({ length: 400 }, (_, index) => `s-${index}`).find(
        (id) => !experimentArm(SALTS.map, id, 0.5) && !experimentArm(SALTS.notes, id, 0.5),
    );
    expect(held).toBeString();
    const answer = sessionStart({ session_id: held ?? "none", source: "startup", cwd: root }, { ...baseEnv(data, root), CLAUDE_PLUGIN_OPTION_HOLDOUT: "0.5" }) as Answer;
    expect(answer?.hookSpecificOutput.additionalContext).toBeUndefined();
    const [row] = readSessions(data);
    expect(row?.arms).toMatchObject({ map: false, notes: false });
    // The control still names the revision it was withheld from, so its turns pair with the treated ones.
    expect(row?.notesRevision).toMatch(/^[0-9a-f]{8}$/);
});

test("a mechanism with nothing to give is not measured: no notes written, no iq installed", () => {
    const root = project();
    rmSync(fieldNotesFile(root));
    const data = tempDir();
    sessionStart({ session_id: "s-6", source: "startup", cwd: root }, { ...baseEnv(data, root), CLAUDE_PLUGIN_OPTION_HOLDOUT: "0.5" });
    const [row] = readSessions(data);
    // The map had areas to show, so it is measured on whichever arm this id drew; the notes and iq had nothing.
    expect(Object.keys(row?.arms ?? {})).toEqual(["map"]);
});

test("a resumed session is not told again or counted again; a compacted one is told again but not counted", () => {
    const root = project();
    const data = tempDir();
    const env = { ...baseEnv(data, root), CLAUDE_PLUGIN_OPTION_HOLDOUT: "0" };
    expect(sessionStart({ session_id: "s-2", source: "resume", cwd: root }, env)).toBeUndefined();
    const compacted = sessionStart({ session_id: "s-2", source: "compact", cwd: root }, env) as Answer;
    expect(compacted?.hookSpecificOutput.additionalContext).toContain("## Map of this project");
    expect(readSessions(data)).toEqual([]);
});

test("the switches a session opened with are kept for the report, whatever it was told", () => {
    const root = project();
    const data = tempDir();
    sessionStart({ session_id: "s-7", source: "resume", cwd: root }, { ...baseEnv(data, root), CLAUDE_PLUGIN_OPTION_SHADOWS: "false", CLAUDE_PLUGIN_OPTION_HOLDOUT: "0.25" });
    expect(loadOptions(data)).toMatchObject({ shadows: false, holdout: 0.25, project_map: true });
});

test("every Bash command of the session learns where the project is and whether fileq is on", () => {
    const root = project();
    const data = tempDir();
    const envFile = join(tempDir(), "env");
    writeFileSync(envFile, "");
    sessionStart({ session_id: "s-3", source: "startup", cwd: root }, { ...baseEnv(data, root), CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_OPTION_FILEQ: "false" });
    expect(readFileSync(envFile, "utf8")).toBe(`export INTENTIC_PROJECT_DIR='${root}'\nexport INTENTIC_FILEQ=0\n`);
});

test("iq switched on without iq installed is said once a day, and teaches nothing", () => {
    const root = project();
    const data = tempDir();
    const env = { ...baseEnv(data, root), CLAUDE_PLUGIN_OPTION_HOLDOUT: "0" };
    const first = sessionStart({ session_id: "s-4", source: "startup", cwd: root }, env) as Answer;
    expect(first?.systemMessage).toContain("the `iq` CLI is not installed");
    expect(first?.hookSpecificOutput.additionalContext).not.toContain("iq workspace search");
    const second = sessionStart({ session_id: "s-5", source: "startup", cwd: root }, env) as Answer;
    expect(second?.systemMessage).toBeUndefined();
});
