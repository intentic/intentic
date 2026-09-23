// A failed turbo run as comparable units: a type diagnostic, a failing test, an unhandled error, else the whole task.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";

// Where turbo writes `--summarize` output, relative to the directory it ran in.
const RUNS_DIR = ".turbo/runs";

// Units a verdict keeps; past this a verdict says it was truncated and its failed tasks stand in for the rest.
export const UNITS_KEPT = 400;

// The JUnit report one `bun test` run of one package writes (suites.mjs) and this module reads back.
export const junitFile = (dir, packageName, kind) => join(dir, `${packageName.replace(/[^a-zA-Z0-9_-]+/g, "_")}.${kind}.xml`);

// The two `bun test` runs suites.mjs makes per package, each with its own per-test budget in ms.
export const SUITE_KINDS = ["unit", "integration"];
export const SUITE_TIMEOUTS = { unit: 20_000, integration: 120_000 };

// Which of the two runs a test file belongs to, read off its name as suites.mjs selects it.
export const suiteKindOf = (file) => (/\.(integration|e2e)\.test\./.test(file) ? "integration" : "unit");

// The export condition every suite resolves workspace packages through, so a test reads source rather than a stale dist.
export const SOURCE_CONDITION = "@intentic/src";

// The summary of the turbo run that started at `since` (epoch ms) in `root`, deleted once read so the next run's is unambiguous.
export const takeSummary = (root, since) => {
    const dir = join(root, RUNS_DIR);
    let newest;
    try {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            const written = name.endsWith(".json") ? statSync(path).mtimeMs : -1;
            if (written >= since && (newest === undefined || written > newest.written)) {
                newest = { path, written };
            }
        }
    } catch {
        return undefined;
    }
    if (newest === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(readFileSync(newest.path, "utf8"));
    } catch {
        return undefined;
    } finally {
        rmSync(newest.path, { force: true });
    }
};

// Tasks that ran and exited non-zero; one turbo skipped behind a failed dependency measured nothing and is not listed.
export const failedTasks = (summary) =>
    (summary?.tasks ?? [])
        .filter((task) => typeof task.execution?.exitCode === "number" && task.execution.exitCode !== 0)
        .map((task) => ({ taskId: task.taskId, name: task.package, task: task.task, directory: task.directory, logFile: task.logFile }));

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

// tsgo / vue-tsc errors in their non-TTY form, `file(line,col): error TScode: message`, first line of each only.
export const typeDiagnostics = (log) =>
    log.split("\n").flatMap((line) => {
        const found = DIAGNOSTIC.exec(line.trim());
        return found === null ? [] : [{ file: found[1], line: Number(found[2]), code: found[4], message: found[5] }];
    });

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) =>
    text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) =>
        entity.startsWith("#x") || entity.startsWith("#X")
            ? String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
            : entity.startsWith("#")
              ? String.fromCodePoint(Number(entity.slice(1)))
              : ENTITIES[entity.toLowerCase()],
    );

// Attribute values are double-quoted with `"` escaped, so `"[^"]*"` cannot stop inside one.
const TESTCASE = /<testcase((?:\s+[\w:-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;

// Every test case in a bun JUnit report and whether it failed; `classname` carries the describe path.
export const junitCases = (xml) =>
    [...xml.matchAll(TESTCASE)].map(([, attributes, body]) => {
        const read = Object.fromEntries([...attributes.matchAll(ATTRIBUTE)].map(([, key, value]) => [key, decode(value)]));
        return {
            file: read.file ?? "",
            name: read.classname ? `${read.classname} > ${read.name}` : (read.name ?? ""),
            failed: body !== undefined && /<(failure|error)\b/.test(body),
        };
    });

// Failing test cases in a bun JUnit report.
export const junitFailures = (xml) => junitCases(xml).flatMap(({ file, name, failed }) => (failed ? [{ file, name }] : []));

const FILE_HEADER = /^(\S.*\.(?:test|spec)\.[cm]?[jt]sx?):$/;
const UNHANDLED = "# Unhandled error between tests";

// Errors bun raised outside any test (a file that cannot load, a rejection after the last test), which JUnit omits.
export const unhandledErrors = (log) => {
    const lines = log.split("\n").map((line) => line.trimEnd());
    const found = [];
    let file = "";
    lines.forEach((line, at) => {
        const header = FILE_HEADER.exec(line);
        if (header !== null) {
            file = header[1];
        } else if (line.startsWith(UNHANDLED)) {
            const message = lines.slice(at + 1, at + 6).find((next) => /^\s*(error\b|\w*Error\b)/.test(next));
            found.push({ file, message: (message ?? "unhandled error").trim() });
        }
    });
    return found;
};

const readOr = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
};

// Absolute paths name whichever checkout ran; digits in an error name ports, pids and durations.
const shapeOf = (message, root) => message.replaceAll(`${root}/`, "").replace(/\d+/g, "#");

// One unit per occurrence, paths repo-relative, so two checkouts of one tree produce the same list.
export const unitsOf = (root, tasks, junitDir) =>
    tasks.flatMap((task) => {
        const log = readOr(join(root, task.logFile ?? ""));
        const at = (file) => posix.join(task.directory ?? "", file);
        const found =
            task.task === "typecheck"
                ? typeDiagnostics(log).map(({ file, code, message }) => `${task.taskId} ${at(file)}: ${code} ${message.replaceAll(`${root}/`, "")}`)
                : task.task === "test"
                  ? [
                        ...(junitDir === undefined ? [] : SUITE_KINDS.flatMap((kind) => junitFailures(readOr(junitFile(junitDir, task.name, kind))))).map(
                            ({ file, name }) => `${task.taskId} ${at(file)} › ${name}`,
                        ),
                        ...unhandledErrors(log).map(({ file, message }) => `${task.taskId} ${at(file)} › unhandled ${shapeOf(message, root)}`),
                    ]
                  : [];
        return found.length > 0 ? found : [task.taskId];
    });

// The task a unit belongs to: everything before its first space.
export const taskOf = (unit) => unit.split(" ", 1)[0];

// Lines of a task's log quoted under a failure no diagnostic or test case could be read out of.
export const LOG_TAIL_LINES = 8;

const ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// The last non-blank lines of a task log, escape codes dropped.
export const logTail = (log, lines = LOG_TAIL_LINES) =>
    log
        .replace(ESCAPE, "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "")
        .slice(-lines);

// One line per unit, and under a whole-task unit (nothing could be read out of it) that task's log tail. Taken a unit
// per task in turn, so a cut list still names every failing task's first failure.
export const failureLines = (root, units, tasks) => {
    const byTask = new Map(tasks.map((task) => [task.taskId, task]));
    const blocks = new Map();
    for (const unit of units) {
        const task = byTask.get(unit);
        const block = task === undefined ? [unit] : [unit, ...logTail(readOr(join(root, task.logFile ?? ""))).map((line) => `  ${line.replaceAll(`${root}/`, "")}`)];
        blocks.set(taskOf(unit), [...(blocks.get(taskOf(unit)) ?? []), block]);
    }
    const queues = [...blocks.values()];
    const depth = Math.max(0, ...queues.map((queue) => queue.length));
    return Array.from({ length: depth }, (_, at) => queues.flatMap((queue) => queue[at] ?? [])).flat();
};

// Packages a re-run command names before the rest are counted.
const COMMAND_PACKAGES = 8;

// The turbo command that re-runs only `tasks`, never the closure's whole filter list.
export const rerunCommand = (tasks) => {
    const names = [...new Set(tasks.map(({ name }) => name))];
    const kinds = [...new Set(tasks.map(({ task }) => task))].sort();
    const filters = names.slice(0, COMMAND_PACKAGES).map((name) => `--filter ${name}`);
    const more = names.length > COMMAND_PACKAGES ? ` (+${names.length - COMMAND_PACKAGES} more)` : "";
    return `pnpm turbo run ${kinds.join(" ")} --only ${filters.join(" ")}${more}`;
};

// Counted per unit, so one more copy of a standing failure is still `mine`; a whole-task unit matches only itself.
export const judgeUnits = (current, known) => {
    const left = new Map();
    for (const unit of known) {
        left.set(unit, (left.get(unit) ?? 0) + 1);
    }
    const mine = [];
    const standing = [];
    for (const unit of current) {
        const remaining = left.get(unit) ?? 0;
        if (remaining > 0) {
            left.set(unit, remaining - 1);
            standing.push(unit);
        } else {
            mine.push(unit);
        }
    }
    return { mine, standing };
};

// A turn's units against the land verdict for its base: `held` are its own, `unsure` fall in a task a truncated verdict cut.
export const againstBaseline = (current, verdict) => {
    const { mine, standing } = judgeUnits(current, verdict?.status === "failed" ? (verdict.failures ?? []) : []);
    const cut = new Set(verdict?.truncated === true ? (verdict.failedTasks ?? []) : []);
    return { held: mine.filter((unit) => !cut.has(taskOf(unit))), standing, unsure: mine.filter((unit) => cut.has(taskOf(unit))) };
};

// A red run's units as a verdict keeps them: capped, with its failed tasks naming what a truncated list left out.
export const verdictUnits = (units, tasks) => ({
    failures: units.slice(0, UNITS_KEPT),
    failedTasks: [...new Set(tasks.map(({ taskId }) => taskId))],
    truncated: units.length > UNITS_KEPT,
});
