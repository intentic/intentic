import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { probeFound, probeNote, probeRgSearch, probeTextFind, type ProbeHit } from "./probes.js";
import { findText, RAN_LITERAL_NOTE } from "./text-search.js";

// The zero-match probes over a real tree with a real rg: each switch that would have found what the search did not, and
// silence when nothing would.

let parent: string;
let root: string;

const put = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
};

beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), "text-probes-"));
    root = join(parent, "work");
    // A repository, as rg reads a .gitignore only inside one.
    await mkdir(root, { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    await put(".gitignore", "dist/\n*.log\nnode_modules/\n");
    await put("src/widget.ts", "export const FooBar = lookup[key+1];\n");
    await put("src/other.ts", "const fooBar = 2;\n");
    await put("dist/bundle.js", "var onlyInDist = 1;\n");
    await put("app.log", "onlyInDist logged\n");
    await put(".secret/conf.cfg", "HIDDEN_ONLY_TOKEN = true\n");
    await put("node_modules/pkg/index.js", "installedOnly();\n");
    await put("node_modules/pkg/.hidden/deep.js", "deepInstalled();\n");
    await put(`${STATE_DIR}/local/cache/derived.txt`, "FLOORED_TOKEN\n");
});
afterAll(() => rm(parent, { recursive: true, force: true }));

const kinds = (hits: readonly ProbeHit[]): string[] => hits.map((hit) => hit.kind);
const probe = async (pattern: string, more: Partial<Parameters<typeof probeRgSearch>[0]> = {}): Promise<ProbeHit[]> =>
    probeRgSearch({ cwd: root, pattern, ...more });

test("a case mismatch names the files any case would have found", async () => {
    const hits = await probe("foobar");
    expect(hits).toEqual([{ kind: "case", files: 2, more: false, examples: ["src/other.ts", "src/widget.ts"] }]);
    expect(probeNote(hits)).toBe("no matches. Would match: case-insensitive (-i) → 2 files (src/other.ts, src/widget.ts)");
});

test("a match only in a gitignored file is found by the ignored probe, named relative to where rg ran", async () => {
    const hits = await probe("onlyInDist");
    expect(hits).toEqual([{ kind: "ignored", files: 2, more: false, examples: ["app.log", "dist/bundle.js"] }]);
    // An absolute path under the cwd is said relative to it, as the shell would print it from there.
    expect((await probe("onlyInDist", { paths: [join(root, "dist")] }))[0]?.examples).toEqual(["dist/bundle.js"]);
});

test("a match only in a hidden directory is found by the ignored probe", async () => {
    const hits = await probe("HIDDEN_ONLY_TOKEN");
    expect(hits).toEqual([{ kind: "ignored", files: 1, more: false, examples: [".secret/conf.cfg"] }]);
    expect(probeNote(hits)).toBe("no matches. Would match: in ignored/hidden files (-uu) → 1 file (.secret/conf.cfg)");
});

test("a pattern with regex syntax that only matches as written is found by the literal probe", async () => {
    const hits = await probe("lookup[key+1]");
    expect(kinds(hits)).toEqual(["literal"]);
    expect(hits[0]?.examples).toEqual(["src/widget.ts"]);
});

test("a string that is genuinely absent gets no probe hit and no note", async () => {
    const hits = await probe("zzz_totally_absent_zzz");
    expect(hits).toEqual([]);
    expect(probeNote(hits)).toBeUndefined();
});

test("installed dependencies and version control stay out of the ignored probe", async () => {
    expect(await probe("installedOnly")).toEqual([]);
    expect(await probe("deepInstalled")).toEqual([]);
    // Named as the search's own path, a dependency tree is searched as asked: its hidden files too.
    expect(kinds(await probe("deepInstalled", { paths: ["node_modules/pkg"] }))).toEqual(["ignored"]);
});

test("a probe that cannot differ from the search is not run", async () => {
    expect(await probe("foobar", { ignoreCase: true })).toEqual([]);
    expect(await probe("HIDDEN_ONLY_TOKEN", { hidden: true, noIgnore: true })).toEqual([]);
    expect(await probe("lookup[key+1]", { literal: true })).toEqual([]);
    // The search's own selection flags narrow every probe.
    expect(await probe("foobar", { flags: ["-g", "*.js"] })).toEqual([]);
});

test("a probe stopped at the file cap says its count is a floor", async () => {
    await Promise.all(Array.from({ length: 205 }, async (_, index) => put(`many/f${String(index).padStart(3, "0")}.txt`, "ManyNeedle\n")));
    const [hit] = await probe("manyneedle", { paths: ["many"] });
    expect(hit).toMatchObject({ kind: "case", files: 200, more: true });
    expect(hit?.examples).toHaveLength(3);
    expect(probeNote([{ kind: "case", files: 4, more: true, examples: ["a", "b", "c"] }])).toBe(
        "no matches. Would match: case-insensitive (-i) → 4+ files (a, b, c, …)",
    );
});

test("a caller that has let go gets no hits, and nothing throws", async () => {
    expect(await probeRgSearch({ cwd: root, pattern: "foobar" }, { signal: AbortSignal.abort() })).toEqual([]);
    expect(await probeTextFind({ root, pattern: "foobar", caseSensitive: true, signal: AbortSignal.abort() })).toEqual([]);
});

test("entered elsewhere, rg runs as the entrant says and the paths still come back relative", async () => {
    const hits = await probeRgSearch(
        { cwd: root, pattern: "foobar" },
        { enter: (command, args) => ({ command: "env", args: [`--chdir=${root}`, command, ...args] }) },
    );
    expect(hits[0]?.examples).toEqual(["src/other.ts", "src/widget.ts"]);
});

test("the search box's probes flip its own switches over its own walk, and the floor holds", async () => {
    // The box's walk already takes dotfiles, so a hidden-only match needs no probe; a case-sensitive miss does.
    expect(kinds(await probeTextFind({ root, pattern: "foobar", caseSensitive: true }))).toEqual(["case"]);
    // Its ignored switch is the box's own toggle, pruned as the rg probe is, and never past the floor.
    expect(await probeTextFind({ root, pattern: "onlyInDist" })).toEqual([{ kind: "ignored", files: 2, more: false, examples: ["app.log", "dist/bundle.js"] }]);
    expect(await probeTextFind({ root, pattern: "installedOnly" })).toEqual([]);
    expect(await probeTextFind({ root, pattern: "FLOORED_TOKEN" })).toEqual([]);
    expect(kinds(await probeTextFind({ root, pattern: "lookup[key+1]" }))).toEqual(["literal"]);
});

test("a box answer is probed only when it found nothing, and a pattern run again as plain text is probed as plain text", async () => {
    const options = { root, pattern: "FOOBAR = lookup[", caseSensitive: true };
    const found = await findText(options);
    expect(found).toMatchObject({ groups: [], note: RAN_LITERAL_NOTE });
    // As a regex the pattern does not read, so only the plain-text reading can find the any-case match.
    expect(await probeFound(options, found)).toEqual([{ kind: "case", files: 1, more: false, examples: ["src/widget.ts"] }]);
    const hit = await findText({ ...options, caseSensitive: false });
    expect(await probeFound(options, hit)).toEqual([]);
});
