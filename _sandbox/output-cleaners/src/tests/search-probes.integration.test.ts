import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptySearchNote } from "../search-probes.mjs";

// The empty-search probes over a real tree with the real rg and grep: the note a search that exited 1 with nothing
// printed earns, silence for a string that is genuinely absent or a command this does not read, and the whole path
// through the filter's binary as the pane runs it.

let root: string;

const put = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
};

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "search-probes-"));
    // A repository, as rg reads a .gitignore only inside one.
    execFileSync("git", ["init", "-q", root]);
    put(".gitignore", "dist/\n");
    put("src/widget.ts", "export const FooBar = lookup[key+1];\n");
    put("dist/bundle.js", "var onlyInDist = 1;\n");
    put(".secret/conf.cfg", "HIDDEN_ONLY_TOKEN = true\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const noteOf = (command: string, options: { exitCode?: string; pipeline?: string; raw?: string; cwd?: string } = {}): string | undefined =>
    emptySearchNote(options.raw ?? "", { command, exitCode: options.exitCode ?? "1", pipeline: options.pipeline ?? "", cwd: options.cwd ?? root });

test("a case mismatch names the file any case finds", () => {
    expect(noteOf(`rg -n foobar`)).toBe("--- no matches. Would match: case-insensitive (-i) → 1 file (src/widget.ts)");
    expect(noteOf(`grep -rn foobar src`)).toBe("--- no matches. Would match: case-insensitive (-i) → 1 file (src/widget.ts)");
});

test("a match only in a gitignored file, or only in a hidden directory, is named by the ignored probe", () => {
    expect(noteOf(`rg onlyInDist`)).toBe("--- no matches. Would match: in ignored/hidden files (-uu) → 1 file (dist/bundle.js)");
    expect(noteOf(`rg HIDDEN_ONLY_TOKEN .`)).toBe("--- no matches. Would match: in ignored/hidden files (-uu) → 1 file (.secret/conf.cfg)");
});

test("a regex-syntax pattern that only matches as written is named by the literal probe", () => {
    expect(noteOf(`rg 'lookup[key+1]' src`)).toBe("--- no matches. Would match: as literal text (-F) → 1 file (src/widget.ts)");
    // grep prints `./src/widget.ts` from `.`; said as the shell's own relative path.
    expect(noteOf(`grep -r 'lookup[key+1]' .`)).toBe("--- no matches. Would match: as literal text (-F) → 1 file (src/widget.ts)");
});

test("a genuinely absent string earns no note", () => {
    expect(noteOf(`rg -n zzz_totally_absent_zzz`)).toBeUndefined();
    expect(noteOf(`grep -rn Zzz_Absent .`)).toBeUndefined();
});

test("a command this does not read, or a search that did find something, is not probed", () => {
    expect(noteOf(`rg foobar | grep -v test`)).toBeUndefined();
    expect(noteOf(`rg foobar; true`)).toBeUndefined();
    expect(noteOf(`rg "$X"`)).toBeUndefined();
    expect(noteOf(`rg foobar`, { raw: "rg: src: Permission denied\n" })).toBeUndefined();
    expect(noteOf(`rg foobar`, { exitCode: "2" })).toBeUndefined();
    expect(noteOf(`rg foobar`, { exitCode: "0" })).toBeUndefined();
});

test("a leading cd is followed, and a trailing head is read through the pipeline's statuses", () => {
    expect(noteOf(`cd ${root}/src && rg foobar`, { cwd: "/" })).toContain("(widget.ts)");
    expect(noteOf(`rg foobar | head -20`, { exitCode: "0", pipeline: "1 0" })).toContain("case-insensitive (-i) → 1 file");
    // With no statuses, the exit code is head's and says nothing about the search.
    expect(noteOf(`rg foobar | head -20`, { exitCode: "0" })).toBeUndefined();
    expect(noteOf(`rg foobar | head -20`, { exitCode: "0", pipeline: "0 0" })).toBeUndefined();
});

test("through the filter's binary, as the pane runs it, the note is the whole answer to an empty search", () => {
    const bin = join(import.meta.dirname, "..", "agent-output-filter.mjs");
    const run = spawnSync("node", [bin, "rg -n foobar", "1", "0", "", ""], { cwd: root, input: "", encoding: "utf8" });
    expect(run.stdout).toBe("--- no matches. Would match: case-insensitive (-i) → 1 file (src/widget.ts)\n");
    const off = spawnSync("node", [bin, "rg -n foobar", "1", "0", "", ""], {
        cwd: root,
        input: "",
        encoding: "utf8",
        env: { ...process.env, INTENTIC_OUTPUT_CLEANERS: "-probes" },
    });
    expect(off.stdout).toBe("");
});
