import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { TEST_FILE } from "./agent-tests.js";

/* WOULD THIS TEST HAVE PASSED BEFORE THE CHANGE IT TESTS?
 *
 * A model writes a test, the test passes, and passing was the thing it was asked for — so nothing in the loop
 * objects. The failure this catches is the one where the test would have passed against the OLD code too: it
 * runs the new behaviour without depending on it, and it will keep passing when that behaviour breaks. It
 * type-checks, it lints, `pnpm verify` is green, and the suite has grown a test that can never fail.
 *
 * Nothing else here can see that. A linter reads the assertion's shape, and the shape of a weak assertion is the
 * shape of a strong one — a 22-key `toEqual` is over-specification or the exact contract depending on what the
 * function promises, which is not in the AST. Coverage says the line ran, not that anything checked it. The only
 * way to know a test detects a fault is to introduce one and watch.
 *
 * SO INTRODUCE THE ONE FAULT THAT IS ALREADY KNOWN. In an agent turn we know exactly which source files changed,
 * which makes "your change, reverted" a free mutant — the cheapest useful one there is. Serve those files' HEAD
 * contents in place of the working copies, re-run the test, and read one bit: if it still passes, it did not test
 * the change.
 *
 * NOTHING IS CHECKED OUT OVER THE WORKING TREE. The HEAD copies are served through a vite `load` hook, which
 * receives the resolved absolute path and can answer with different text — so the files on disk are never
 * touched. A hook that reverted source in place would be trading a whole turn's work against a lint-grade signal
 * the first time it crashed between the revert and the restore. The one thing written is a config file next to
 * the package's own, removed in a `finally` and overwritten by the next run if a crash ever leaves it behind.
 *
 * IT IS ASKED AT THE STOP, of every test file the turn touched, by the `verify-tests` built-in (agent-tests.ts,
 * rules/turn-ending.ts). It used to run inside a PostToolUse hook on the first edit of each test file, which
 * measured the first draft rather than the finished test, only where the edit tools could see the edit, and under
 * a 20-second budget sized to the agent's patience mid-turn. At the Stop the test is finished, the tree says
 * which files were touched whatever wrote them, and the moment already waits on a check that takes minutes.
 *
 * IT REPORTS, IT NEVER BLOCKS, and that is not timidity — two entirely legitimate cases pass this check:
 *   a test written BEFORE its implementation, which is red right now and which the agent can already see;
 *   a pure refactor, where a test that keeps passing is the whole point of the exercise.
 * Telling those apart from a weak test needs intent, so the fact goes back as context and the model decides. A
 * gate here would fight correct work several times for every weak test it caught.
 *
 * SAME PACKAGE ONLY. A package's vitest run loads its own code from source, which is what the `load` hook can
 * swap; an import of another package resolves to that package's built output, where there is nothing to
 * intercept. Reporting on a cross-package change would be measuring the dist from the last build. */

const exec = promisify(execFile);

/* One package's suite for one file, at the Stop. 60s buys the slow packages a real answer where 20s (the old
 * mid-turn budget) gave up on them; the built-in caps how many files it asks about, so the worst case at this
 * moment is bounded by that cap times this. A timeout reads as "no answer" and says nothing, like every other
 * failure in this file, so the cost of giving up is a missed report and never a wrong one. */
const RUN_TIMEOUT_MS = 60_000;
// What a package's own vitest config is called. Without one there is no suite to borrow settings from — jsdom,
// setup files, the timeouts — and a generated config would run the test under different conditions than the
// package does, which is a different measurement wearing this one's name.
const PACKAGE_CONFIG = "vitest.config.ts";
const GENERATED_CONFIG = ".intentic-head.vitest.config.mts";

const SOURCE_FILE = /\.[cm]?[jt]sx?$|\.vue$/;

const git = async (cwd: string, ...args: readonly string[]): Promise<string | undefined> => {
    try {
        const { stdout } = await exec("git", [...args], { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 1 << 26 });
        return stdout;
    } catch {
        // No repo, no HEAD, a path git does not know: all of them mean there is no baseline to compare against,
        // which is silence rather than a finding.
        return undefined;
    }
};

/* The package a file belongs to: the nearest ancestor with a vitest config, stopping at the repo root. Walked
 * rather than looked up, because this has to work for any workspace layout and the daemon holds no package map
 * for repos that are not this one. */
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

/* The mutant set: source files, in THIS package, that the turn has changed.
 *
 * A test file is excluded on purpose, and it is the exclusion that matters. Reverting the tests too would ask
 * "do the old tests pass against the old code", which is a different question with a known answer, and it would
 * make every finding vacuous.
 *
 * Same package only, because a package's vitest run loads its own code from source — which is what the `load`
 * hook can swap — while an import of a sibling package resolves to that package's built output, where there is
 * nothing to intercept. Reporting on a cross-package change would be measuring the last build. */
export const changedSourceIn = (diff: string, repoRoot: string, packageDir: string): readonly string[] =>
    diff
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => resolve(repoRoot, line))
        .filter((file) => file.startsWith(packageDir + sep) && !TEST_FILE.test(file) && SOURCE_FILE.test(file));

export interface TestStrengthDeps {
    // The repository the turn is working in. Every path below is resolved against it, and git is run in it.
    readonly repoRoot: string;
}

/* The generated config: the package's own, plus a `load` hook that answers with HEAD's text for the changed
 * files. `enforce: "pre"` so it runs before vite's own loader, and the plugin is repeated into each project
 * because a `projects` config does not inherit root plugins into its children.
 *
 * Written as `.mts` with no imports of its own beyond the package config, so nothing here depends on what is
 * resolvable from a temp directory. */
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

/* Runs the one test file against HEAD's source and answers whether it PASSED, which is the finding: the
 * repo-relative source files that were restored for the run. Undefined means no answer: nothing changed to
 * compare against, the package has no config, git could not produce a baseline, or the run itself broke. Every
 * one of those is silence. */
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
            // A file with no HEAD version is NEW in this turn. Leaving it out of the map is right: the test then
            // imports a module that does not exist at HEAD, the run fails, and a failing run is not a finding.
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
            // Non-zero: the test FAILED against HEAD, which is the healthy case and the common one. Also where a
            // broken run lands, and the two are deliberately not told apart — both mean "no finding".
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
