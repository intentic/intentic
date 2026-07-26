import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* The tasks imp-bench runs, and the only thing that decides whether a run passed. Every task grades
 * MECHANICALLY — an exact grid, an exact integer — because an LLM judge would put the thing under test on both
 * sides of the measurement, and because a benchmark you re-run weekly has to be free.
 *
 * Two tasks, picked for the two claims imp mode makes:
 *
 *   arc   — does splitting thinking from doing make the pair SMARTER? One task from the ARC-AGI-2 public
 *           evaluation set (Apache-2.0, fetched by id, never vendored). That set is deliberately brutal for
 *           frontier models, and it is a fair test of the split rather than a pure-reasoning quiz because the
 *           only strategy that works agentically is: guess the rule, write a program, run it against the
 *           training pairs, look at what broke, revise. The guessing is the architect's; the writing and
 *           running is the imp's.
 *
 *   sweep — is the pair more TOKEN-EFFICIENT on the retrieval-heavy work it was built for? "Count this
 *           identifier across the codebase, excluding comments" over a real, large TypeScript tree. Naive
 *           grepping gets it wrong (comments and word boundaries), so it needs a small program written and run
 *           — again, reasoning on one side, mechanics on the other — and the answer is one integer either
 *           right or wrong. This stands in for a CursorBench-style "real request over a real codebase with a
 *           curated answer": CursorBench itself is Cursor-internal and not published, so it cannot be run here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = resolve(HERE, "../src");
const CONTRACT_SRC = resolve(HERE, "../../../_libs/sandbox-contract/src");

interface Graded {
    // The headline pass/fail the solved-rate is computed from.
    readonly solved: boolean;
    // Partial credit in [0,1], so a near-miss is visible instead of reading the same as a total failure.
    readonly score: number;
    // One line for the per-run log: what the agent actually answered.
    readonly detail: string;
}

interface PreparedTask {
    readonly prompt: string;
    // Deterministic grading over the workspace the run left behind.
    readonly grade: () => Promise<Graded>;
}

export interface BenchTask {
    readonly id: string;
    readonly title: string;
    // Materialize the workspace for ONE run. Called per run, so every arm and repetition starts identical.
    readonly prepare: (dir: string) => Promise<PreparedTask>;
}

// ---- shared helpers ----------------------------------------------------------------------------------------

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

// The agent's answer file, or undefined when it never wrote one / wrote something unparseable. Not an error:
// "didn't answer" is a legitimate benchmark outcome and must score 0 rather than crash the run.
const readAnswer = async (dir: string, name: string): Promise<unknown> => readJson(join(dir, name)).catch(() => undefined);

// ---- arc: one ARC-AGI-2 evaluation task --------------------------------------------------------------------

interface ArcPair {
    readonly input: number[][];
    readonly output: number[][];
}
interface ArcTask {
    readonly train: ArcPair[];
    readonly test: ArcPair[];
}

const ARC_BASE = "https://raw.githubusercontent.com/arcprize/ARC-AGI-2/main/data/evaluation";
// Cached outside the repo: the corpus is Apache-2.0 and public, but it is not ours to vendor, and a benchmark
// that re-downloads on every run is a benchmark that fails offline for a silly reason.
const ARC_CACHE = join(tmpdir(), "intentic-arc-agi-2");

const fetchArcTask = async (id: string): Promise<ArcTask> => {
    const cached = join(ARC_CACHE, `${id}.json`);
    const local = await readJson(cached).catch(() => undefined);
    if (local !== undefined) {
        return local as ArcTask;
    }
    const response = await fetch(`${ARC_BASE}/${id}.json`);
    if (!response.ok) {
        throw new Error(`ARC task ${id}: ${response.status} ${response.statusText} — check the id against ${ARC_BASE}`);
    }
    const task = (await response.json()) as ArcTask;
    await mkdir(ARC_CACHE, { recursive: true });
    await writeFile(cached, JSON.stringify(task));
    return task;
};

const sameGrid = (a: unknown, b: number[][]): boolean =>
    Array.isArray(a) &&
    a.length === b.length &&
    a.every((row, y) => Array.isArray(row) && row.length === b[y]!.length && row.every((cell, x) => cell === b[y]![x]));

// How much of the grid is right, for partial credit — 0 when the shape itself is wrong, since a differently
// shaped grid has no cell-wise correspondence to score against.
const gridScore = (a: unknown, b: number[][]): number => {
    if (!Array.isArray(a) || a.length !== b.length || a.some((row, y) => !Array.isArray(row) || row.length !== b[y]!.length)) {
        return 0;
    }
    const cells = b.reduce((sum, row) => sum + row.length, 0);
    const hits = b.reduce((sum, row, y) => sum + row.filter((cell, x) => (a[y] as number[])[x] === cell).length, 0);
    return cells === 0 ? 0 : hits / cells;
};

const arcTask = (id: string): BenchTask => ({
    id: `arc:${id}`,
    title: `ARC-AGI-2 ${id} — infer the transformation, verify it against the training pairs, apply it`,
    prepare: async (dir) => {
        const task = await fetchArcTask(id);
        const expected = task.test[0]?.output;
        if (expected === undefined) {
            throw new Error(`ARC task ${id} has no test pair`);
        }
        // The fixture carries the training pairs and the test INPUT only. The expected output never touches the
        // workspace — otherwise the "solution" is a file read.
        await writeFile(join(dir, "task.json"), `${JSON.stringify({ train: task.train, test: [{ input: task.test[0]!.input }] }, undefined, 2)}\n`);
        return {
            prompt: [
                "`task.json` in this directory is an ARC-AGI puzzle: a `train` list of input/output grid pairs that all share ONE transformation rule, and a `test` list holding a single input grid.",
                "A grid is a list of rows; each cell is an integer 0-9 naming a colour.",
                "Work out the rule from the training pairs, then apply it to the test input.",
                "Your rule must reproduce EVERY training pair exactly — check that it does before you answer, rather than assuming it.",
                'Write your predicted output grid to `answer.json` in this directory, as JSON: {"output": [[...], [...]]}.',
                "Answer from the task file alone. Do not search the internet, and do not ask the user anything.",
            ].join("\n\n"),
            grade: async () => {
                const answer = (await readAnswer(dir, "answer.json")) as { output?: unknown } | undefined;
                const grid = answer?.output;
                const score = gridScore(grid, expected);
                return {
                    solved: sameGrid(grid, expected),
                    score,
                    detail:
                        grid === undefined
                            ? "no answer.json"
                            : `${Array.isArray(grid) ? `${grid.length}x${(grid[0] as unknown[])?.length ?? 0}` : "malformed"} vs ${expected.length}x${expected[0]!.length}, ${Math.round(score * 100)}% cells`,
                };
            },
        };
    },
});

// ---- sweep: exhaustive retrieval over a real TypeScript tree ------------------------------------------------

// Strip // line comments and /* */ block comments, leaving string and template literals intact. Deliberately a
// scanner rather than a regex: `"http://x"` and `` `a /* b */ c` `` are exactly the cases a regex gets wrong,
// and they are what makes the task worth setting. This is the rule the prompt states, so the agent is being
// asked to reimplement THIS, not to guess at an ambiguous one.
export const stripComments = (source: string): string => {
    let out = "";
    let index = 0;
    let quote: string | undefined;
    while (index < source.length) {
        const char = source[index]!;
        const next = source[index + 1];
        if (quote !== undefined) {
            out += char;
            if (char === "\\") {
                out += next ?? "";
                index += 2;
                continue;
            }
            if (char === quote) {
                quote = undefined;
            }
            index += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            out += char;
            index += 1;
            continue;
        }
        if (char === "/" && next === "/") {
            while (index < source.length && source[index] !== "\n") {
                index += 1;
            }
            continue;
        }
        if (char === "/" && next === "*") {
            index += 2;
            while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
                index += 1;
            }
            index += 2;
            continue;
        }
        out += char;
        index += 1;
    }
    return out;
};

// Whole-word, case-sensitive occurrences — the same rule the prompt states.
export const countWord = (text: string, word: string): number => text.match(new RegExp(`\\b${word}\\b`, "g"))?.length ?? 0;

// The files the sweep counts over, and the files it copies: the fixture's own sources, tests excluded.
const isCountedFile = (path: string): boolean => path.endsWith(".ts") && !path.endsWith(".test.ts");

const walkFiles = async (dir: string, keep: (path: string) => boolean): Promise<string[]> => {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...(await walkFiles(path, keep)));
        } else if (keep(path)) {
            found.push(path);
        }
    }
    return found;
};

// The identifier to count. Picked for the shape of the problem rather than the number: it appears all over the
// daemon in BOTH code and prose, so the comment rule actually bites, and a plain `grep -c` is wrong.
const SWEEP_WORD = "sessionId";

// A COPY of the real sources, never the live checkout: the agent may write anywhere in its workspace, and this
// repo is routinely being edited by someone else while a bench runs. Tests are left out — they would skew both
// the identifier count and the import graph, and they are not what either question is about.
const copyDaemonFixture = async (dir: string): Promise<string> => {
    const workspace = join(dir, "daemon");
    await mkdir(workspace, { recursive: true });
    await cp(SANDBOX_SRC, join(workspace, "src"), { recursive: true, filter: (src) => !src.endsWith(".test.ts") });
    await cp(CONTRACT_SRC, join(workspace, "contract"), { recursive: true, filter: (src) => !src.endsWith(".test.ts") });
    return workspace;
};

// ---- deps: hold a large import graph in your head ----------------------------------------------------------

// The entry point whose transitive closure is the answer. Chosen because it sits at the top of the daemon's
// deepest subsystem: reaching every file it pulls in means opening roughly half the tree.
const DEPS_ENTRY = "src/agent/agent.routes.ts";

// Relative import specifiers in a source file: `from "./x.js"` and `await import("../y/z.js")`. Bare
// specifiers (`@intentic/…`, `node:fs`) are deliberately not followed — the graph is this tree's own.
const relativeSpecifiers = (text: string): string[] => [
    ...[...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]!),
    ...[...text.matchAll(/import\("(\.[^"]+)"\)/g)].map((match) => match[1]!),
];

// NodeNext source imports the EMITTED name, so `./agent.js` is `agent.ts` on disk. A specifier that resolves
// outside the copied tree (or to an excluded test) simply has no node in this graph.
const resolveSpecifier = (workspace: string, from: string, specifier: string, present: ReadonlySet<string>): string | undefined => {
    const path = relative(workspace, resolve(dirname(join(workspace, from)), specifier))
        .replaceAll("\\", "/")
        .replace(/\.js$/, ".ts");
    return present.has(path) ? path : undefined;
};

// Every file reachable from `entry` by following relative imports, excluding the entry itself.
const importClosure = async (workspace: string, entry: string): Promise<Set<string>> => {
    const present = new Set((await walkFiles(workspace, isCountedFile)).map((file) => relative(workspace, file).replaceAll("\\", "/")));
    const reached = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
        const current = queue.shift()!;
        const text = await readFile(join(workspace, current), "utf8").catch(() => "");
        for (const specifier of relativeSpecifiers(text)) {
            const target = resolveSpecifier(workspace, current, specifier, present);
            if (target !== undefined && target !== entry && !reached.has(target)) {
                reached.add(target);
                queue.push(target);
            }
        }
    }
    return reached;
};

// The task frontier models are expected to struggle with, and the one imp mode should be best placed to win:
// the ANSWER is a single number, but reaching it means opening ~93 of the tree's 198 files and keeping a
// running graph straight. A single agent's context fills with source it must then reason over; an architect
// with no tools never sees a byte of it — only the imp's summary — so its context stays the size of the
// problem rather than the size of the codebase. Answering from the entry file alone gives 25, so a run that
// never went transitive is unmistakable in the result rather than merely wrong.
const depsTask: BenchTask = {
    id: "deps",
    title: `count the transitive relative-import closure of ${DEPS_ENTRY}`,
    prepare: async (dir) => {
        const workspace = await copyDaemonFixture(dir);
        const expected = (await importClosure(workspace, DEPS_ENTRY)).size;
        return {
            prompt: [
                `\`daemon/\` in this workspace is a TypeScript codebase. Starting at \`daemon/${DEPS_ENTRY}\`, follow its imports transitively and count how many DISTINCT files are reachable.`,
                "Count by exactly these rules, which are not negotiable — the answer is checked against them:",
                [
                    "- Follow only RELATIVE specifiers: those starting with `./` or `../`. Ignore package imports like `@intentic/sandbox-contract` and `node:fs`.",
                    '- A specifier counts when it appears in a `from "…"` clause or an `import("…")` call, including `import type`.',
                    "- Imports name the emitted file, so `./agent.js` means the file `agent.ts` on disk.",
                    "- Follow the graph TRANSITIVELY: files imported by imported files count too, to any depth.",
                    "- Count each file once, and do NOT count the starting file itself.",
                    "- If a specifier resolves to a file that is not present, ignore it.",
                ].join("\n"),
                'Write the result to `answer.json` in the workspace root, as JSON: {"count": <integer>}.',
                "Do not ask the user anything.",
            ].join("\n\n"),
            grade: async () => {
                const answer = (await readAnswer(dir, "answer.json")) as { count?: unknown } | undefined;
                const count = typeof answer?.count === "number" ? answer.count : undefined;
                const score = count === undefined || expected === 0 ? 0 : Math.max(0, 1 - Math.abs(count - expected) / expected);
                return {
                    solved: count === expected,
                    score,
                    detail: `${count === undefined ? "no answer.json" : `answered ${count}`}, expected ${expected}`,
                };
            },
        };
    },
};

// ---- defects: read a large codebase and notice what is WRONG in it ----------------------------------------

// Four deliberate defects planted into the copied tree. Each is syntactically valid, semantically wrong, and
// contradicted by intent that is visible right where it sits — a comment, a name, or the obvious purpose of the
// function. None is findable by pattern: no regex knows that slicing 6 characters contradicts a comment saying
// 8, so an agent has to READ and UNDERSTAND, across a tree far too large to hold at once.
//
// This is the task built for the question "does splitting thinking from doing raise frontier intelligence" —
// the one to run as Opus architect + Opus imp against an Opus orchestrator spawning Opus subagents, since with
// model strength held equal on both halves the only variable left is who holds the tools:
//
//   bench:imp --tasks defects --model opus --imp-model opus --arms subagent,duo
//
// Anchors are exact source strings, and prepare() THROWS if one no longer matches, so an edit upstream breaks
// the benchmark loudly instead of silently planting three defects and grading against four.
interface Defect {
    readonly file: string;
    readonly find: string;
    readonly replace: string;
    // Why it is wrong — never shown to the agent, only used when reporting what it missed.
    readonly why: string;
}

const DEFECTS: readonly Defect[] = [
    {
        file: "src/agent/agent-terminals.ts",
        find: 'const id = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 8);',
        replace: 'const id = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 6);',
        why: "the comment directly above promises 8 characters of the session id; this takes 6",
    },
    {
        file: "src/agent/turn-usage.ts",
        find: "const add = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : a + b);",
        replace:
            "const add = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : a - b);",
        why: "sumUsage must ADD two accounting frames; this subtracts, so totals shrink as a turn spends more",
    },
    {
        file: "src/agent/event-queue.ts",
        find: "            if (this.ended) {\n                return;\n            }",
        replace: "            if (!this.ended) {\n                return;\n            }",
        why: "the queue must finish iteration once ended; inverted, it returns while still open and hangs when closed",
    },
    {
        file: "src/agent/agent-steering.ts",
        find: "        this.delivered += 1;",
        replace: "        this.delivered = 1;",
        why: "`delivered` counts how many messages were accepted (see its comment); assignment makes it a flag stuck at 1",
    },
];

// 1-based line number of `needle`'s first line in `text`.
const lineOf = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split("\n").length;

interface PlantedDefect {
    readonly file: string;
    readonly line: number;
}

const plantDefects = async (workspace: string): Promise<PlantedDefect[]> => {
    const planted: PlantedDefect[] = [];
    for (const defect of DEFECTS) {
        const path = join(workspace, defect.file);
        const before = await readFile(path, "utf8");
        if (!before.includes(defect.find)) {
            throw new Error(
                `defects task: anchor no longer present in ${defect.file}. The source changed under the benchmark — re-anchor this defect:\n  ${defect.find}`,
            );
        }
        const after = before.replace(defect.find, defect.replace);
        await writeFile(path, after);
        planted.push({ file: `daemon/${defect.file}`, line: lineOf(after, defect.replace) });
    }
    return planted;
};

// A reported defect matches a planted one when it names the same file and lands within a couple of lines —
// close enough that the agent clearly found THIS defect, loose enough not to punish an off-by-one.
const LINE_TOLERANCE = 2;
const matches = (claim: { file?: unknown; line?: unknown }, planted: PlantedDefect): boolean =>
    typeof claim.file === "string" &&
    typeof claim.line === "number" &&
    (claim.file === planted.file || claim.file.endsWith(planted.file.replace("daemon/", ""))) &&
    Math.abs(claim.line - planted.line) <= LINE_TOLERANCE;

// How many files the agent is actually asked to read. Sized on purpose: large enough that holding all of it
// while judging each line is real work (~46k tokens of dense code), small enough that a careful agent FINISHES.
// An unscoped version of this task had a run read all 235 files of the tree and still have no answer at 600s —
// a benchmark nobody completes produces no comparison at all, only timeouts.
const DEFECT_SCOPE = "src/agent";

const defectsTask: BenchTask = {
    id: "defects",
    title: `find ${DEFECTS.length} planted defects in daemon/${DEFECT_SCOPE}`,
    prepare: async (dir) => {
        const workspace = await copyDaemonFixture(dir);
        const planted = await plantDefects(workspace);
        // Counted from the fixture rather than hardcoded, so the prompt cannot drift from what is on disk.
        const scopeFiles = (await walkFiles(join(workspace, DEFECT_SCOPE), isCountedFile)).length;
        return {
            prompt: [
                `\`daemon/${DEFECT_SCOPE}/\` in this workspace is a subsystem of a TypeScript daemon — ${scopeFiles} source files — into which exactly ${DEFECTS.length} defects have been deliberately introduced. Every defect is in that directory; the rest of \`daemon/\` is untouched and you do not need to read it.`,
                "Each one is syntactically valid code that is semantically WRONG: it contradicts a comment beside it, the name of the thing it is in, or the evident purpose of the function. None of them is a typo, and none can be found by searching for a pattern — you have to read code and judge whether it does what it is meant to do.",
                `Find all ${DEFECTS.length}. Report each as the workspace-relative file path and the 1-based line number of the offending line.`,
                `Write your answer to \`answer.json\` in the workspace root, as JSON: {"defects": [{"file": "daemon/src/…", "line": 42}, …]}. Report exactly ${DEFECTS.length} — a list padded with guesses scores worse than a short one.`,
                "Do not ask the user anything.",
            ].join("\n\n"),
            grade: async () => {
                const answer = (await readAnswer(dir, "answer.json")) as { defects?: unknown } | undefined;
                const claims = Array.isArray(answer?.defects) ? (answer.defects as { file?: unknown; line?: unknown }[]) : [];
                const found = planted.filter((defect) => claims.some((claim) => matches(claim, defect)));
                // F1, so both misses and padding cost: a run that lists twenty candidates to cover four defects
                // has not found them, it has declined to choose.
                const precision = claims.length === 0 ? 0 : found.length / claims.length;
                const recall = found.length / planted.length;
                const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
                const missed = planted.filter((defect) => !found.includes(defect));
                return {
                    solved: found.length === planted.length && claims.length === planted.length,
                    score,
                    detail:
                        claims.length === 0
                            ? `no defects reported, ${planted.length} planted`
                            : `found ${found.length}/${planted.length} in ${claims.length} claims${missed.length > 0 ? ` · missed ${missed.map((defect) => `${defect.file}:${defect.line}`).join(", ")}` : ""}`,
                };
            },
        };
    },
};

const sweepTask: BenchTask = {
    id: "sweep",
    title: `count \`${SWEEP_WORD}\` in code across a real TypeScript tree, excluding comments`,
    prepare: async (dir) => {
        const workspace = await copyDaemonFixture(dir);

        // Ground truth is computed from the fixture the agent is looking at, not hardcoded — so the task stays
        // valid as this repo changes, and the expected number can never silently rot.
        const files = await walkFiles(workspace, isCountedFile);
        let expected = 0;
        for (const file of files) {
            expected += countWord(stripComments(await readFile(file, "utf8")), SWEEP_WORD);
        }
        return {
            prompt: [
                `The \`daemon/\` directory in this workspace is a TypeScript codebase. Count how many times the identifier \`${SWEEP_WORD}\` appears in its CODE.`,
                "Count by exactly these rules, which are not negotiable — the answer is checked against them:",
                [
                    "- Only `.ts` files under `daemon/` (there are no other file types there).",
                    "- Whole-word, case-sensitive matches only: `sessionIds` or `mySessionId` do NOT count.",
                    "- Ignore anything inside a `//` line comment or a `/* */` block comment.",
                    "- Text inside string and template literals DOES count, and a `//` or `/*` that appears inside a string literal does not start a comment.",
                ].join("\n"),
                'Write the result to `answer.json` in the workspace root, as JSON: {"count": <integer>}.',
                "Do not ask the user anything.",
            ].join("\n\n"),
            grade: async () => {
                const answer = (await readAnswer(dir, "answer.json")) as { count?: unknown } | undefined;
                const count = typeof answer?.count === "number" ? answer.count : undefined;
                // Partial credit by relative error, so "off by 3" and "off by 300" don't read the same.
                const score = count === undefined || expected === 0 ? 0 : Math.max(0, 1 - Math.abs(count - expected) / expected);
                // The expected count rides the line either way: a run that answered nothing is the case where
                // you most want to know what it was supposed to say.
                return {
                    solved: count === expected,
                    score,
                    detail: `${count === undefined ? "no answer.json" : `answered ${count}`}, expected ${expected} (${files.length} files)`,
                };
            },
        };
    },
};

// ---- registry ----------------------------------------------------------------------------------------------

// The default ARC task. Any id from the ARC-AGI-2 public evaluation set works — pass `arc:<id>` to swap it,
// which is how you check that a result is about imp mode rather than about one puzzle.
const DEFAULT_ARC_ID = "0934a4d8";

export const taskFor = (spec: string): BenchTask => {
    if (spec === "sweep") {
        return sweepTask;
    }
    if (spec === "deps") {
        return depsTask;
    }
    if (spec === "defects") {
        return defectsTask;
    }
    if (spec === "arc") {
        return arcTask(DEFAULT_ARC_ID);
    }
    if (spec.startsWith("arc:")) {
        return arcTask(spec.slice("arc:".length));
    }
    throw new Error(`unknown task "${spec}" — expected: sweep, deps, defects, arc, or arc:<task-id>`);
};
