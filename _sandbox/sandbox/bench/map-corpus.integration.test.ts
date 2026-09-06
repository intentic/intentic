import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { workspaceMapNote } from "../src/agent/prompt/workspace-map.js";
import { mapStats, parseMapNote } from "./map-corpus.js";

/* THE PARSER IS READING A FORMAT NOBODY WROTE DOWN, which is the whole risk in this bench: `workspace-map.ts`
 * renders the note by padding columns to a width computed from the names in it, and a parser written against
 * one example is a parser that breaks the first time the widest name changes. So the fixtures here are RENDERED
 * BY THE RENDERER rather than typed out, and the test asserts the round trip. A change to the note's shape that
 * this file does not survive is a change that would otherwise have made the bench quietly report zeros.
 *
 * The corpus fixtures are hand-written, because the transcript format is somebody else's and the expected
 * answers there are arithmetic rather than a snapshot of whatever the parser happened to do. */

let dir: string | undefined;
afterEach(() => {
    if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    }
});

// A workspace the real renderer will describe: three areas of different sizes, one of them carrying a package
// manifest so its row gets a purpose line and the others do not.
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
    /* Biggest first, then alphabetical among equals, which is the renderer's own ranking: `notes` and `site`
     * hold one file each. `engine/src` is between them because `engine` holds seven of the project's nine
     * files, so the renderer opens it up, and reading its children as areas of the project is exactly what
     * this parser has to get right. */
    expect(parsed?.areas.map((area) => area.name)).toEqual(["engine", "engine/src", "notes", "site"]);
    // Sizes come off the same walk the renderer printed, so this is the renderer's own count, not a guess.
    expect(parsed?.areas[0]).toMatchObject({ files: 7, purpose: true, child: false, here: false });
    expect(parsed?.areas[1]).toMatchObject({ name: "engine/src", files: 6, child: true });
    // A manifest with no description leaves the row without a purpose line rather than inventing one.
    expect(parsed?.areas.filter((area) => area.purpose).map((area) => area.name)).toEqual(["engine"]);
    expect(parsed?.here).toBeUndefined();
    expect(parsed?.truncated).toBe(false);
    // The user's own message is not part of the note, which is what the char count is a cost of.
    expect(parsed?.chars).toBe(note?.length);
});

test("a message with no map reads as a session that was not sent one", () => {
    expect(parseMapNote("just a prompt, no note above it")).toBeUndefined();
});

/* THE FAILURE THIS PARSER ACTUALLY HAD, and the reason it anchors on the rows rather than the head. The note's
 * opening paragraph has been rewritten twice; a parser keyed to one wording read every note written under the
 * others as a map listing nothing, and a map listing nothing dilutes every share computed from it without
 * anything looking wrong. Both of these are real notes from this workspace's own corpus. */
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
    // The request underneath is not part of the note, and neither is the blank line before it.
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
    // The mapped session searched instead of listing; the unmapped one listed. That difference is the whole
    // reading, and it is invisible in the searches: both ran exactly one.
    expect(stats.opening.mapped.openedWithListing).toBe("0.0%");
    expect(stats.opening.unmapped.openedWithListing).toBe("100.0%");
    expect(stats.opening.mapped.searchesPerOpeningTurn).toBe(1);
    expect(stats.opening.unmapped.searchesPerOpeningTurn).toBe(1);
    expect(stats.opening.mapped.firstActions).toMatchObject({ "bash:rg": "100.0%" });

    // One of the two listed areas was entered, so half the note's lines earned their characters.
    expect(stats.payload).toMatchObject({ sessions: 1, areasListed: 2, areasUsed: 1, linesUsed: "50.0%", firstFileInsideAListedArea: "100.0%" });
    expect(stats.payload.perArea).toEqual([
        { area: "api", listed: 1, used: 1, share: "100.0%" },
        { area: "web", listed: 1, used: 0, share: "0.0%" },
    ]);
});

/* An area name is relative to the PROJECT the map described, and every path in a transcript is relative to the
 * workspace. A conversation opened inside a repo is where the two come apart, and reading `_editor` against
 * `intentic/_editor` scored every one of those sessions as having gone somewhere the map never mentioned. */
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
    // …while coverage still counts where the session went afterwards: an area line is worth its characters if
    // the session ever gets there.
    expect(stats.payload.areasUsed).toBe(2);
});
