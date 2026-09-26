// What `suites` discovers in a package that holds build output beside its source: a stale pruned `deploy/` copy (what
// failed verify-platform on 2026-09-26), a directory only the package's .gitignore names, and one only its bunfig
// names. Every stale file throws when loaded, so a run that picks one up fails, and each file that runs records its
// name, so the run is judged by exactly what it ran.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SUITES = join(import.meta.dir, "../bin/suites.mjs");

const KEPT = (name: string): string =>
    `import { appendFileSync } from "node:fs";\ntest("${name}", () => { appendFileSync(process.env.SUITES_TEST_TRACE!, "${name}\\n"); });\n`;
const STALE = (name: string): string =>
    `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.SUITES_TEST_TRACE!, "${name}\\n");\nthrow new Error("Cannot find module '@intentic/gone'");\n`;

let root = "";
let traceDir = "";
let trace = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "suites-discovery-"));
    // Outside the package, so the trace is no file of the run's own.
    traceDir = mkdtempSync(join(tmpdir(), "suites-trace-"));
    trace = join(traceDir, "ran");
    const files = {
        "package.json": JSON.stringify({ name: "@example/pkg" }),
        ".gitignore": "build-out/\n",
        "bunfig.toml": `[test]\npathIgnorePatterns = ["**/__fixtures__/**"]\n`,
        "src/kept.test.ts": KEPT("kept"),
        "src/kept.integration.test.ts": KEPT("kept.integration"),
        "deploy/src/stale.test.ts": STALE("deploy unit"),
        "deploy/src/stale.integration.test.ts": STALE("deploy integration"),
        "build-out/stale.test.ts": STALE("gitignored unit"),
        "src/__fixtures__/stale.test.ts": STALE("bunfig-ignored unit"),
    };
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    writeFileSync(trace, "");
    spawnSync("git", ["init", "-q"], { cwd: root });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(traceDir, { recursive: true, force: true });
});

const suites = (...args: string[]) => {
    const result = spawnSync("node", [SUITES, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SUITES_TEST_TRACE: trace, TEST_WORKERS: "1", SUITES_JUNIT_DIR: "" },
    });
    const ran = readFileSync(trace, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .toSorted();
    return { status: result.status, output: `${result.stdout}${result.stderr}`, ran };
};

test("a whole run discovers the source's tests and none under build output, gitignored or bunfig-ignored directories", () => {
    const { status, output, ran } = suites();
    expect({ status, ran }).toEqual({ status: 0, ran: ["kept", "kept.integration"] });
    expect(output).not.toContain("@intentic/gone");
});

test("a path filter chooses among the same files: one that names only stale output finds nothing", () => {
    const { status, output, ran } = suites("stale");
    expect({ status, ran }).toEqual({ status: 1, ran: [] });
    expect(output).toContain(`suites: no test file's path contains "stale"`);
});

test("a path filter that names source runs it, still past the stale copies beside it", () => {
    const { status, ran } = suites("kept");
    expect({ status, ran }).toEqual({ status: 0, ran: ["kept", "kept.integration"] });
});
