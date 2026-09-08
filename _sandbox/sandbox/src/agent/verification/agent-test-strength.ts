import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { TEST_FILE } from "@intentic/constants/assertion-measure";

// Reverts this turn's changed source in one package to HEAD and reruns the test: if it still passes, the test didn't
// test the change. Reports only, never blocks (a red TDD test or a passing refactor are fine); vitest-run only, same
// package only, invoked at Stop by `verify-tests` via a vite `load` hook — nothing on disk changes.

const exec = promisify(execFile);

// A timeout is silence, like any other failure here, not a wrong report.
const RUN_TIMEOUT_MS = 60_000;
// Name of a package's own vitest config; without one there is no suite to borrow settings from.
const PACKAGE_CONFIG = "vitest.config.ts";
const GENERATED_CONFIG = ".intentic-head.vitest.config.mts";

const SOURCE_FILE = /\.[cm]?[jt]sx?$|\.vue$/;

const git = async (cwd: string, ...args: readonly string[]): Promise<string | undefined> => {
    try {
        const { stdout } = await exec("git", [...args], { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 1 << 26 });
        return stdout;
    } catch {
        // No repo, no HEAD, or an unrecognized path all mean no baseline: silence, not a finding.
        return undefined;
    }
};

// Nearest ancestor with a vitest config, stopping at the repo root; walked since there is no package map for an
// arbitrary workspace.
export const packageOf = (file: string, repoRoot: string): string | undefined => {
    let directory = dirname(resolve(file));
    const root = resolve(repoRoot);
    while (directory.startsWith(root)) {
        if (existsSync(join(directory, PACKAGE_CONFIG))) {
            return directory;
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return undefined;
        }
        directory = parent;
    }
    return undefined;
};

// Source files this turn changed within this package, excluding tests (reverting tests too would just re-ask "do old
// tests pass old code") and cross-package files (their imports resolve to built output, not source).
export const changedSourceIn = (diff: string, repoRoot: string, packageDir: string): readonly string[] =>
    diff
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => resolve(repoRoot, line))
        .filter((file) => file.startsWith(packageDir + sep) && !TEST_FILE.test(file) && SOURCE_FILE.test(file));

export interface TestStrengthDeps {
    // Repo root every path below is resolved against; git also runs here.
    readonly repoRoot: string;
}

// Package config plus a `load` hook swapping in HEAD's text for changed files, `enforce: "pre"` so it runs before
// vite's own loader and repeated per project since `projects` don't inherit root plugins.
const configSource = (packageDir: string, head: ReadonlyMap<string, string>): string => {
    const pairs = [...head].map(([live, copy]) => `[${JSON.stringify(live)}, ${JSON.stringify(copy)}]`).join(", ");
    return [
        `import { readFileSync } from "node:fs";`,
        `import base from "./${PACKAGE_CONFIG}";`,
        ``,
        `const HEAD = new Map([${pairs}]);`,
        `const headSource = {`,
        `    name: "intentic-head-source",`,
        `    enforce: "pre",`,
        `    load(id) {`,
        `        const at = HEAD.get(id.split("?")[0]);`,
        `        return at === undefined ? null : readFileSync(at, "utf8");`,
        `    },`,
        `};`,
        ``,
        `const resolved = typeof base === "function" ? await base({ command: "serve", mode: "test" }) : base;`,
        `const projects = resolved?.test?.projects;`,
        `export default {`,
        `    ...resolved,`,
        `    plugins: [...(resolved?.plugins ?? []), headSource],`,
        `    test: {`,
        `        ...resolved?.test,`,
        `        ...(Array.isArray(projects)`,
        `            ? { projects: projects.map((one) => ({ ...one, plugins: [...(one?.plugins ?? []), headSource] })) }`,
        `            : {}),`,
        `    },`,
        `};`,
        ``,
    ].join("\n");
};

// Runs one test file against HEAD's source; returns the repo-relative files that were reverted, or undefined for any
// no-answer case (nothing changed, no config, no baseline, or the run itself broke).
export const passesAgainstHead = async (testFile: string, deps: TestStrengthDeps): Promise<readonly string[] | undefined> => {
    const packageDir = packageOf(testFile, deps.repoRoot);
    if (packageDir === undefined) {
        return undefined;
    }
    const status = await git(deps.repoRoot, "diff", "--name-only", "HEAD", "--");
    if (status === undefined) {
        return undefined;
    }
    const changed = changedSourceIn(status, deps.repoRoot, packageDir);
    if (changed.length === 0) {
        return undefined;
    }

    const scratch = mkdtempSync(join(tmpdir(), "intentic-head-"));
    const generated = join(packageDir, GENERATED_CONFIG);
    try {
        const head = new Map<string, string>();
        for (const [index, file] of changed.entries()) {
            const text = await git(deps.repoRoot, "show", `HEAD:${relative(deps.repoRoot, file)}`);
            // A missing HEAD version means the file is new; skip it so the run fails on the import, not a misreport.
            if (text === undefined) {
                continue;
            }
            const copy = join(scratch, `${index}-${basename(file)}`);
            writeFileSync(copy, text);
            head.set(file, copy);
        }
        if (head.size === 0) {
            return undefined;
        }
        writeFileSync(generated, configSource(packageDir, head));
        try {
            await exec("npx", ["vitest", "run", testFile, "--config", generated, "--reporter=dot"], {
                cwd: packageDir,
                encoding: "utf8",
                timeout: RUN_TIMEOUT_MS,
                maxBuffer: 1 << 26,
            });
        } catch {
            // Non-zero also covers a broken run; both mean no finding here, and are not told apart.
            return undefined;
        }
        return [...head.keys()].map((file) => relative(deps.repoRoot, file));
    } catch {
        return undefined;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
        rmSync(generated, { force: true });
    }
};
