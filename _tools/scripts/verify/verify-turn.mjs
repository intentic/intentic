#!/usr/bin/env node
// THE TURN CHECK: what a change ADDED to the findings of the checks CI runs on every push, read while the conversation
// that made it can still act on it. The sandbox runs it once when an isolated turn is about to stop (`turn` in
// .intentic/checks.json; _sandbox/sandbox/src/agent/run/turn-checks.ts) and says what it printed back to the model,
// which may fix it or say why not. Nothing waits on it: it holds no turn, land, commit or push. By hand it is
// `node _tools/scripts/verify/verify-turn.mjs [--base <sha>]`.
//
// The tree is judged as it stands, committed and uncommitted work together, files nobody has added to git yet included,
// against the commit the work is built on: `--base`, else where HEAD left the main line. Only what the change added is
// reported, `code` checks included, where CI's push check fails one outright (verify-push.mjs): many conversations run
// at once, and a failure main already carries would send every one of them after the same breakage. The judging is the
// push check's own (check-snapshot.mjs, turn-findings.mjs, measure-change.mjs), so the two cannot disagree about what a
// change added.
//
// Exits 1 with one line per added finding on stdout. Exits 0 when the change added nothing, and when it cannot judge
// (no base, a sparse checkout, checks that did not answer, a base it could not check out, a fault of its own such as a full
// disk), saying why on stderr: a run
// that could not look is no finding about the change.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";
import { changesSince, git } from "../lib/git.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { sortJudged } from "./measure-change.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";

// Where a change is read as leaving the main line, asked in this order: the local default branch, then the remote's
// own idea of it, so a clone that never checked `main` out still has an answer.
const MAIN_LINES = ["main", "origin/HEAD", "origin/main"];

// Findings printed per check before the rest are counted: enough to act on, while a check that broke wholesale cannot
// fill the turn's context.
export const LINES_PER_CHECK = 15;

const MANIFEST = "_tools/checks/manifest.mjs";

/** The commit the change is judged against: `--base` as a commit this clone holds, else where HEAD left the first main
 *  line that answers; undefined when neither can be named. */
export const baseOf = (root, baseArg) => {
    if (baseArg !== undefined) {
        const named = git(root, "rev-parse", "-q", "--verify", `${baseArg}^{commit}`)?.trim() ?? "";
        return named === "" ? undefined : named;
    }
    for (const line of MAIN_LINES) {
        const base = git(root, "merge-base", "HEAD", line)?.trim() ?? "";
        if (base !== "") {
            return base;
        }
    }
    return undefined;
};

/**
 * The check ids the manifest at `base` lists; undefined when it cannot be read. A check the change itself added has no
 * "before", so everything it finds is the change's, and naming it to the base's runner would only make that runner
 * refuse the whole question. Read by importing the file's own text: the manifest is one plain export with no imports.
 */
export const checksAt = async (root, base) => {
    const source = git(root, "show", `${base}:${MANIFEST}`);
    if (source === undefined) {
        return undefined;
    }
    try {
        const { CHECKS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
        return new Set(CHECKS.map(({ id }) => id));
    } catch {
        // allow(silent-catch): a manifest that no longer loads on its own is asked about whole, as before this read
        return undefined;
    }
};

// A finding as its check printed it, without the indent and bullet a check's own report leads each one with.
const bare = (line) => line.trim().replace(/^-\s+/, "");

const idsOf = (group) => group.map(({ verdict }) => verdict.id).join(", ");

/**
 * What a run says, given the commit it judged against, every verdict, and what the change is charged with (`judged`,
 * measure-change.mjs's sortJudged; undefined when the base could not be asked): `out` for stdout, `notes` for stderr,
 * and the exit code. Pure, so the wording is pinned without a tree.
 */
export const turnReport = ({ base, verdicts, judged }) => {
    const at = base.slice(0, 9);
    const notes = [];
    const unmeasured = verdicts.filter((verdict) => !verdict.measured);
    if (unmeasured.length > 0) {
        notes.push(`${unmeasured.map(({ id }) => id).join(", ")}: could not measure, so nothing there is judged — the check needs a look, not the change`);
    }
    if (judged === undefined) {
        const failing = verdicts.filter((verdict) => verdict.measured && !verdict.ok);
        notes.push(`${at} could not be checked out to compare against, so nothing is charged to this change (failing: ${failing.map(({ id }) => id).join(", ")})`);
        return { out: [], notes, code: 0 };
    }
    if (judged.theirs.length > 0) {
        notes.push(`${idsOf(judged.theirs)}: already failing at ${at}, and no worse for this change`);
    }
    if (judged.excused.length > 0) {
        notes.push(`${judged.excused.map(({ verdict, reasons }) => `${verdict.id} (${reasons.join("; ")})`).join(", ")}: declared by an Allow: trailer`);
    }
    if (judged.unsure.length > 0) {
        notes.push(`${idsOf(judged.unsure)}: ${at} could not run these, so nothing they found is charged to this change`);
    }
    if (judged.mine.length === 0) {
        notes.push(`nothing added against ${at}`);
        return { out: [], notes, code: 0 };
    }
    const out = judged.mine.flatMap(({ verdict, added }) => [
        ...added.slice(0, LINES_PER_CHECK).map((line) => `✗ ${verdict.id}: ${bare(line)}`),
        ...(added.length > LINES_PER_CHECK ? [`✗ ${verdict.id}: … and ${added.length - LINES_PER_CHECK} more`] : []),
    ]);
    const total = judged.mine.reduce((sum, { added }) => sum + added.length, 0);
    const ids = judged.mine.map(({ verdict }) => verdict.id);
    // The whole report names main's own findings too, which are no more this change's for being printed beside its own.
    out.push(
        `verify-turn: ${total} finding(s) this change added against ${at}. Each check's whole report, main's own findings included: node _tools/checks/run.mjs --only ${ids.join(",")}`,
    );
    // The one exception a model can declare without editing the code: CI's push check reads the trailer on the commit
    // the work lands in, and the land copies it there from the conversation's last word.
    if (judged.mine.some(({ verdict }) => verdict.gate === "tidy")) {
        out.push("A tidy finding that is right where it stands is declared, with its reason, by an `Allow: <check> — <reason>` line ending your final message.");
    }
    return { out, notes, code: 1 };
};

const note = (line) => process.stderr.write(`verify-turn: ${line}\n`);

// Why no base could be named.
const noBase = (baseArg) =>
    baseArg === undefined
        ? `HEAD shares no commit with ${MAIN_LINES.join(", ")}, so there is nothing to judge the change against`
        : `--base ${baseArg === "" ? "was given no commit" : `${baseArg} is not a commit this clone holds`}, so nothing is judged`;

// Why the tree is not worth judging against `base`, or undefined when it is.
const unjudged = (root, base) => {
    // A checkout cut to a fence holds part of the tree, and a whole-tree check reads what it left out as missing.
    if (git(root, "config", "--get", "core.sparseCheckout")?.trim() === "true") {
        return "this checkout is sparse, and whole-tree checks would read what it left out as missing, so nothing is judged";
    }
    // One diff instead of every check, for the run that has nothing to judge; a diff git cannot answer judges anyway.
    const changed = changesSince(root, base).paths;
    return changed !== undefined && changed.length === 0 ? `nothing changed since ${base.slice(0, 9)}` : undefined;
};

/**
 * A throwaway copy of the checkout's index that also lists every untracked, unignored file, as intent-to-add; undefined
 * when git cannot build one. Most checks find their files with `git ls-files`, and a file a turn created stays untracked
 * until the work is committed, so without this the checks would read the change minus everything new in it, which is
 * where a change adds most. A copy, so the checkout's own index, which is the agent's and the land's, is never touched.
 * It also lists scratch the sandbox keeps out of a land (a log, a new hidden folder), which can surface here as a
 * finding nobody will push.
 */
export const indexWithNewFiles = (root, dir) => {
    const own = git(root, "rev-parse", "--git-path", "index")?.trim();
    if (own === undefined) {
        return undefined;
    }
    const copy = join(dir, "index");
    try {
        copyFileSync(resolve(root, own), copy);
    } catch {
        // allow(silent-catch): a checkout with no index yet (nothing ever added) is read through git's own listing
        return undefined;
    }
    const added = spawnSync("git", ["add", "--intent-to-add", "--", "."], { cwd: root, env: { ...process.env, GIT_INDEX_FILE: copy }, stdio: "ignore" });
    return added.status === 0 ? copy : undefined;
};

/**
 * The files the change moved, as a map from where the tree has each now to where `base` had it: git's own rename
 * detection over the tree as it stands, through the index that lists the new files (`env`, indexWithNewFiles), since a
 * file moved and not yet added shows as a deletion and an untracked file otherwise. Empty when git cannot answer, which
 * charges the change with a moved file's findings, the safe direction to be wrong in.
 */
export const renamesSince = (root, base, env = process.env) => {
    const listed = spawnSync("git", ["diff", "-M", "--name-status", "-z", base], { cwd: root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
    const renames = new Map();
    if (listed.status !== 0) {
        return renames;
    }
    const fields = listed.stdout.split("\0");
    // `R100 <from> <to>`, every other status carries one path.
    for (let index = 0; index < fields.length; index += 1) {
        if (/^[RC]/.test(fields[index] ?? "")) {
            if (fields[index].startsWith("R")) {
                renames.set(fields[index + 2], fields[index + 1]);
            }
            index += 2;
        } else {
            index += 1;
        }
    }
    return renames;
};

// Every check once on the tree as it stands, new files included (indexWithNewFiles), with the files the change moved;
// undefined when the checks did not answer.
const verdictsNow = (root, base) => {
    const scratch = mkdtempSync(join(tmpdir(), "verify-turn-"));
    try {
        const index = indexWithNewFiles(root, scratch);
        const env = index === undefined ? process.env : { ...process.env, GIT_INDEX_FILE: index };
        const verdicts = checkVerdicts(root, undefined, env);
        return verdicts === undefined ? undefined : { verdicts, renames: renamesSince(root, base, env) };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

// What the change is charged with, from every check's verdict on the tree as it stands: only a check that did not pass
// is asked again, at the base. Undefined when the base could not be asked.
const judgeTree = async (root, base, verdicts, renames) => {
    const failing = verdicts.filter((verdict) => verdict.measured && !verdict.ok);
    const known = failing.length === 0 ? undefined : await checksAt(root, base);
    const asked = failing.filter(({ id }) => known === undefined || known.has(id)).map(({ id }) => id);
    // No check failed, or only checks the base never had: there is nothing to ask the base, and nothing it could miss.
    const before = asked.length === 0 ? new Map() : reportsAt(root, base, asked);
    return before === undefined ? undefined : sortJudged(root, base, judgeAgainstBase(failing, before, root, renames));
};

// `root` and `args` are the checkout and the command line's arguments; exported so the whole run can be exercised in a
// checkout of a test's own. Throws only for a fault of its own, which `runGuarded` answers.
export const run = async (root, args) => {
    const baseArg = args.includes("--base") ? (args[args.indexOf("--base") + 1] ?? "") : undefined;
    const base = baseOf(root, baseArg);
    const why = base === undefined ? noBase(baseArg) : unjudged(root, base);
    if (why !== undefined) {
        note(why);
        return 0;
    }
    const now = verdictsNow(root, base);
    if (now === undefined) {
        note("the checks did not answer (node _tools/checks/run.mjs --json), so nothing is judged");
        return 0;
    }
    const { out, notes, code } = turnReport({ base, verdicts: now.verdicts, judged: await judgeTree(root, base, now.verdicts, now.renames) });
    for (const line of notes) {
        note(line);
    }
    for (const line of out) {
        process.stdout.write(`${line}\n`);
    }
    return code;
};

/**
 * `run`, with a fault of the run's own (a full disk, a git that cannot be started) said on stderr and exit 0: a run that
 * could not look is no finding about the change, and exit 1 is the one answer that says there is one. An uncaught throw
 * would exit 1 with a stack trace the model is told to fix.
 */
export const runGuarded = async (root, args) => {
    try {
        return await run(root, args);
    } catch (error) {
        note(`could not judge the change (${error instanceof Error ? error.message : String(error)}), so nothing is judged`);
        return 0;
    }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    // `exitCode`, not `exit`: stdout into a pipe drains after the write, and exiting at once could cut the list short.
    process.exitCode = await runGuarded(repoRoot(import.meta.url), process.argv.slice(2));
}
