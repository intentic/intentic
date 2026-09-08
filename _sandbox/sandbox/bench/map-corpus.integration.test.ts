import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { workspaceMapNote } from "../src/agent/prompt/workspace-map.js";
import { mapStats, parseMapNote } from "./map-corpus.js";

// Workspace fixtures are produced by workspace-map.ts itself, not hand-typed, so a renderer change that breaks parsing
// shows here. Corpus fixtures are hand-written; their expected values are arithmetic, not renderer output.

let dir: string | undefined;
afterEach(() => {
    if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    }
});

// Three areas of different sizes; only `engine` has a package manifest, so only its row gets a purpose line.
const workspaceOf = (): string => {
    dir = mkdtempSync(join(tmpdir(), "map-corpus-"));
    const root = join(dir, "work");
    mkdirSync(join(root, "engine", "src"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "engine", "package.json"), JSON.stringify({ name: "engine", description: "The part that does the work" }));
    for (let index = 0; index < 6; index += 1) {
        writeFileSync(join(root, "engine", "src", `unit-${index}.ts`), "export const x = 1;\n");
    }
    writeFileSync(join(root, "site", "index.html"), "<html></html>\n");
    writeFileSync(join(root, "notes", "todo.md"), "# todo\n");
    return root;
};

test("the note the renderer produces is the note this reads back", () => {
    const root = workspaceOf();
    const note = workspaceMapNote({ root, cwd: root });
    expect(note).toEqual(expect.stringContaining("## Map of this project"));

    const parsed = parseMapNote(`${note ?? ""}\n\nfix the thing please`);
    // Order mirrors the renderer: biggest first, alphabetical among equals.
    expect(parsed?.areas.map((area) => area.name)).toEqual(["engine", "engine/src", "notes", "site"]);
    expect(parsed?.areas[0]).toMatchObject({ files: 7, purpose: true, child: false, here: false });
    expect(parsed?.areas[1]).toMatchObject({ name: "engine/src", files: 6, child: true });
    // No manifest description: no purpose line, rather than inventing one.
    expect(parsed?.areas.filter((area) => area.purpose).map((area) => area.name)).toEqual(["engine"]);
    expect(parsed?.here).toBeUndefined();
    expect(parsed?.truncated).toBe(false);
    // chars counts only the note, not the user's message appended after it.
    expect(parsed?.chars).toBe(note?.length);
});

test("a message with no map reads as a session that was not sent one", () => {
    expect(parseMapNote("just a prompt, no note above it")).toBeUndefined();
});

test("a note whose wording changed still reads, because the rows did not", () => {
    const older = [
        "## Map of this project",
        "",
        "Not the user's words. The daemon read this off the filesystem when this conversation opened, so it is current.",
        "",
        "You are at the top of the workspace.",
        "",
        "the workspace — 5 areas",
        "  intentic      3333 files · ts, vue",
        "                A workspace for coding agents.",
        "  docs          7 files · md",
        "",
        "and now the actual request",
    ].join("\n");
    const parsed = parseMapNote(older);
    expect(parsed?.areas.map((area) => area.name)).toEqual(["intentic", "docs"]);
    expect(parsed?.project).toBe("");
    // chars excludes the trailing blank line and the request after it.
    expect(parsed?.chars).toBe(older.indexOf("\n\nand now"));
});

test("a header with no rows under it is not a map that listed nothing", () => {
    expect(parseMapNote("## Map of this project\n\nsomething went wrong and no areas were written")).toBeUndefined();
});

test("the run's own area is recognised as the one it is standing in", () => {
    const root = workspaceOf();
    const note = workspaceMapNote({ root, cwd: join(root, "engine") });
    const parsed = parseMapNote(note ?? "");
    expect(parsed?.here).toBe("engine");
});

/* ---- the corpus reading ---- */

let clock = 0;
const at = (): string => new Date(1_700_000_000_000 + (clock += 1000)).toISOString();

const prompt = (text: string): string => JSON.stringify({ type: "user", timestamp: at(), message: { content: text } });
const asks = (calls: { name: string; input: Record<string, unknown> }[]): string[] =>
    calls.map((call, index) =>
        JSON.stringify({
            type: "assistant",
            timestamp: at(),
            message: { content: [{ type: "tool_use", id: `t${index}`, name: call.name, input: call.input }] },
        }),
    );

const corpusOf = (sessions: string[][]): string => {
    dir ??= mkdtempSync(join(tmpdir(), "map-corpus-"));
    const projects = join(dir, "projects");
    mkdirSync(projects, { recursive: true });
    sessions.forEach((lines, index) => writeFileSync(join(projects, `session-${index}.jsonl`), `${lines.join("\n")}\n`));
    return projects;
};

const NOTE = ["## Map of this project", "", "You are at the top of the workspace.", "", "the workspace, 2 areas", "  api     9 files · ts", "  web     4 files · ts"].join("\n");

test("scores the opening turn's listings by arm, and the map's lines by whether anyone used them", () => {
    const root = corpusOf([
        [
            prompt(`${NOTE}\n\nfix the login bug`),
            ...asks([
                { name: "Bash", input: { command: `rg login ${WORKSPACE_ROOT}/api` } },
                { name: "Read", input: { file_path: `${WORKSPACE_ROOT}/api/login.ts` } },
            ]),
        ],
        [
            prompt("fix the login bug"),
            ...asks([
                { name: "Bash", input: { command: `ls ${WORKSPACE_ROOT}` } },
                { name: "Read", input: { file_path: `${WORKSPACE_ROOT}/api/login.ts` } },
            ]),
        ],
    ]);
    const stats = mapStats(root, { agentRoot: WORKSPACE_ROOT });

    expect(stats.corpus).toMatchObject({ sessions: 2, mapped: 1 });
    // Mapped session searched, unmapped listed; search counts alone don't show the difference.
    expect(stats.opening.mapped.openedWithListing).toBe("0.0%");
    expect(stats.opening.unmapped.openedWithListing).toBe("100.0%");
    expect(stats.opening.mapped.searchesPerOpeningTurn).toBe(1);
    expect(stats.opening.unmapped.searchesPerOpeningTurn).toBe(1);
    expect(stats.opening.mapped.firstActions).toMatchObject({ "bash:rg": "100.0%" });

    expect(stats.payload).toMatchObject({ sessions: 1, areasListed: 2, areasUsed: 1, linesUsed: "50.0%", firstFileInsideAListedArea: "100.0%" });
    expect(stats.payload.perArea).toEqual([
        { area: "api", listed: 1, used: 1, share: "100.0%" },
        { area: "web", listed: 1, used: 0, share: "0.0%" },
    ]);
});

// Area names are project-relative (`_editor`); transcript paths are workspace-relative (`intentic/_editor`).
test("an area of a project inside the workspace is matched against workspace-relative paths", () => {
    const note = [
        "## Map of this project",
        "",
        "You are at the top of `intentic`.",
        "",
        "`intentic`, 2 areas",
        "  _editor     9 files · ts",
        "  _sandbox    4 files · ts",
    ].join("\n");
    const root = corpusOf([[prompt(`${note}\n\nfix it`), ...asks([{ name: "Read", input: { file_path: `${WORKSPACE_ROOT}/intentic/_editor/app.ts` } }])]]);
    const stats = mapStats(root, { agentRoot: WORKSPACE_ROOT });
    expect(stats.payload.firstFileInsideAListedArea).toBe("100.0%");
    expect(stats.payload.perArea[0]).toEqual({ area: "intentic/_editor", listed: 1, used: 1, share: "100.0%" });
});

test("a subagent's transcript is not a session: it was never sent a map", () => {
    const root = corpusOf([
        [prompt(`${NOTE}\n\nfix it`), ...asks([{ name: "Bash", input: { command: `ls ${WORKSPACE_ROOT}` } }])],
        [JSON.stringify({ type: "user", isSidechain: true, timestamp: at(), message: { content: "go and look" } })],
    ]);
    expect(mapStats(root, { agentRoot: WORKSPACE_ROOT }).corpus.sessions).toBe(1);
});

test("only the opening turn's calls are scored, since that is the only turn the map is sent to", () => {
    const root = corpusOf([
        [
            prompt(`${NOTE}\n\nfix it`),
            ...asks([{ name: "Read", input: { file_path: `${WORKSPACE_ROOT}/api/login.ts` } }]),
            prompt("now check the other one"),
            ...asks([
                { name: "Bash", input: { command: `ls ${WORKSPACE_ROOT}` } },
                { name: "Read", input: { file_path: `${WORKSPACE_ROOT}/web/app.ts` } },
            ]),
        ],
    ]);
    const stats = mapStats(root, { agentRoot: WORKSPACE_ROOT });
    expect(stats.opening.mapped.openedWithListing).toBe("0.0%");
    // Coverage (areasUsed) counts all turns, not just the opening one.
    expect(stats.payload.areasUsed).toBe(2);
});
