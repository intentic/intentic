import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

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

// Long enough for a cold suite on a loaded box, short enough that a hung run cannot hold the turn. A timeout here
// reads as "no answer" and says nothing, like every other failure in this file.
const RUN_TIMEOUT_MS = 90_000;
// What a package's own vitest config is called. Without one there is no suite to borrow settings from — jsdom,
// setup files, the timeouts — and a generated config would run the test under different conditions than the
// package does, which is a different measurement wearing this one's name.
const PACKAGE_CONFIG = "vitest.config.ts";
const GENERATED_CONFIG = ".intentic-head.vitest.config.mts";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$|\.vue$/;

const EDIT_TOOLS = "Edit|Write|NotebookEdit|mcp__hashline__edit|mcp__hashline__write";

const editedPath = (input: unknown): string | undefined => {
    const named = input as { file_path?: unknown; path?: unknown };
    const path = typeof named.file_path === "string" ? named.file_path : named.path;
    return typeof path === "string" && path !== "" ? path : undefined;
};

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

interface TestStrengthDeps {
    // The repository the turn is working in. Every path below is resolved against it, and git is run in it.
    readonly repoRoot: string;
}

/* One notice, in the words the agent needs to act. Names the test, says plainly what was and was not shown, and
 * gives the two legitimate answers out loud — because the failure mode of a bare "this test is weak" is a model
 * that dutifully adds assertions to a refactor's test until something goes red. */
const notice = (testFile: string, changed: readonly string[]): string =>
    [
        `${testFile} passes against the code as it was before this turn's changes.`,
        ``,
        `It was re-run with ${changed.length === 1 ? "this file" : "these files"} restored to HEAD, and it still passed:`,
        ...changed.map((file) => `  ${file}`),
        ``,
        `That means the test does not depend on what the change did. If the behaviour it covers broke tomorrow,`,
        `this test would stay green.`,
        ``,
        `Two answers are legitimate and neither needs work: the implementation is not written yet, or this is a`,
        `refactor and the test passing either way is the point. Otherwise, add the assertion that would fail`,
        `without the change — usually at a boundary, and usually an exact value where the current assertion is a`,
        `relational one.`,
    ].join("\n");

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

/* Runs the one test file against HEAD's source and answers whether it PASSED, which is the finding. Undefined
 * means no answer: nothing changed to compare against, the package has no config, git could not produce a
 * baseline, or the run itself broke. Every one of those is silence. */
const passesAgainstHead = async (testFile: string, deps: TestStrengthDeps): Promise<readonly string[] | undefined> => {
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

/* Takes the two raw values rather than a prepared object, so the caller has no branch of its own: the whole of
 * "is this on" lives here, in one place, instead of being half-decided at the call site the way a `deps ?? …`
 * would leave it. */
export const testStrengthHooks = (enabled: boolean | undefined, repoRoot: string | undefined): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (enabled !== true || repoRoot === undefined) {
        return {};
    }
    const deps: TestStrengthDeps = { repoRoot };
    /* Scoped per turn, so a test file edited five times in a row is reported once. The model needs the fact once;
     * repeating it is how a notice becomes something to scroll past. */
    const told = new Set<string>();
    return {
        PostToolUse: [
            {
                matcher: EDIT_TOOLS,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const file = editedPath(input.tool_input);
                        if (file === undefined || !TEST_FILE.test(file) || told.has(file)) {
                            return {};
                        }
                        told.add(file);
                        const changed = await passesAgainstHead(resolve(file), deps);
                        if (changed === undefined) {
                            return {};
                        }
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PostToolUse",
                                additionalContext: notice(relative(deps.repoRoot, resolve(file)), changed),
                            },
                        };
                    },
                ],
            },
        ],
    };
};
