import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_DIR, STATE_DIR } from "@intentic/constants";
import { readRepoIgnores, repoPattern } from "../ignores/repo-ignores.js";
import { ignoreMatcher as residueMatcher } from "../ignores/residue.js";
import { ignoreMatcher as projectIgnoreMatcher } from "../project/project-files.js";
import { IGNORES, ignoresFor, PROJECT_IGNORES } from "../ssh.js";

// What a project folder's sync leaves on the device, as one file both sides read: this agent, whose list is what sync
// actually does, and the desktop app (`_editor/desktop-app/src-tauri/src/project.rs` NOT_SYNCED), whose "Work on this
// with an agent" counts the folder without it and tells the owner what stays behind.
// SAFETY: the fixture is this repository's own file, written to this shape; one that drifted fails both cases below.
const FIXTURE = JSON.parse(readFileSync(new URL("../project-ignores.fixture.json", import.meta.url), "utf8")) as {
    readonly ignores: readonly string[];
};

test("a project folder's sync ignores exactly the shared list, in its order", () => {
    expect(PROJECT_IGNORES).toStrictEqual(FIXTURE.ignores);
});

test("the workspace's own session ignores the same list plus the state dir and the reference shelf, anchored at its root", () => {
    expect([...IGNORES].sort()).toStrictEqual([...FIXTURE.ignores, `/${STATE_DIR}`, `/${REFERENCE_DIR}`].sort());
});

// What a repository's own `.intentic/sync.json` adds to that list (repo-ignores.ts), read off real temp trees.
const folder = (files: Readonly<Record<string, string>>): string => {
    const root = mkdtempSync(join(tmpdir(), "repo-ignores-"));
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
};

const syncFile = (ignore: unknown): string => JSON.stringify({ ignore });

describe("repoPattern", () => {
    it("reads a path from the repository's root, with or without a leading or trailing slash", () => {
        expect(repoPattern("runs")).toEqual({ path: "runs" });
        expect(repoPattern("/runs/")).toEqual({ path: "runs" });
        expect(repoPattern("bench/data/*.bin")).toEqual({ path: "bench/data/*.bin" });
    });

    it("refuses what would widen sync or match more than it says", () => {
        for (const raw of ["", "/", "!node_modules", "!.env", "**/runs", "a/**", "run?", "[ab]", "a/../b", "./a", "a//b", "a\\b", "*", "a/*/**"]) {
            expect("refused" in repoPattern(raw), raw).toBe(true);
        }
    });
});

describe("readRepoIgnores", () => {
    it("scopes each workspace repository's patterns to that repository, top level and one below", () => {
        const root = folder({
            [`integra/${STATE_DIR}/sync.json`]: syncFile(["/runs", "bench/*.bin"]),
            [`extensions/tool/${STATE_DIR}/sync.json`]: syncFile(["out"]),
        });
        expect(readRepoIgnores(root, false)).toEqual({ patterns: ["/extensions/tool/out", "/integra/bench/*.bin", "/integra/runs"], problems: [] });
    });

    it("never reads the workspace root's own state dir, the reference shelf, or anything deeper than two levels", () => {
        const root = folder({
            [`${STATE_DIR}/sync.json`]: syncFile(["everything"]),
            [`refs/lib/${STATE_DIR}/sync.json`]: syncFile(["src"]),
            [`a/b/c/${STATE_DIR}/sync.json`]: syncFile(["deep"]),
        });
        expect(readRepoIgnores(root, false).patterns).toEqual([]);
    });

    it("reads a project folder's own file, anchored at its root", () => {
        const root = folder({ [`${STATE_DIR}/sync.json`]: syncFile(["runs", "runs"]) });
        expect(readRepoIgnores(root, true).patterns).toEqual(["/runs"]);
    });

    it("keeps the good patterns of a file and names the refused ones", () => {
        const root = folder({ [`app/${STATE_DIR}/sync.json`]: syncFile(["runs", "!.env"]) });
        const read = readRepoIgnores(root, false);
        expect(read.patterns).toEqual(["/app/runs"]);
        expect(read.problems).toHaveLength(1);
        expect(read.problems[0]).toContain('"!.env"');
    });

    it("leaves a malformed file out whole and says so, without throwing", () => {
        const root = folder({ [`app/${STATE_DIR}/sync.json`]: "{ not json", [`web/${STATE_DIR}/sync.json`]: JSON.stringify({ ignore: "runs" }) });
        const read = readRepoIgnores(root, false);
        expect(read.patterns).toEqual([]);
        expect(read.problems).toHaveLength(2);
    });
});

describe("ignoresFor", () => {
    it("appends a repository's patterns to the built-in list, which stays first and whole", () => {
        const root = folder({ [`integra/${STATE_DIR}/sync.json`]: syncFile(["runs"]) });
        expect(ignoresFor({ localDir: root })).toEqual([...IGNORES, "/integra/runs"]);
        const project = folder({ [`${STATE_DIR}/sync.json`]: syncFile(["runs"]) });
        expect(ignoresFor({ project: true, localDir: project })).toEqual([...PROJECT_IGNORES, "/runs"]);
    });

    it("is the built-in list itself where no repository asks for anything", () => {
        expect(ignoresFor({ localDir: folder({}) })).toBe(IGNORES);
    });
});

describe("a repository's patterns elsewhere in the agent", () => {
    it("are matched exactly by the copy-first comparison", () => {
        const ignored = projectIgnoreMatcher(["/runs", "/bench/data/*.bin"]);
        expect(ignored("runs/session-1/log.txt")).toBe(true);
        expect(ignored("bench/data/a.bin")).toBe(true);
        expect(ignored("src/runs/a.rs")).toBe(false);
        expect(ignored("bench/data/a.txt")).toBe(false);
        expect(ignored("bench/data/deeper/a.bin")).toBe(false);
    });

    // A folder holding only what a person chose not to sync is not build output, so the residue heal never deletes it.
    it("are never residue", () => {
        expect(residueMatcher([...IGNORES, "/runs", "runs"])("runs")).toBe(false);
        expect(residueMatcher([...IGNORES, "/runs"])("node_modules")).toBe(true);
    });
});