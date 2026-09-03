import { spawn } from "node:child_process";
import type { Rule } from "@intentic/sandbox-contract";
import { plainText } from "../terminal/plain-text.js";
import { conditionHolds, standing } from "./rules.js";
import { workspaceRelative } from "./turn-ending.js";

/* THE MOMENT A FILE IS WRITTEN, every rule standing there, run on that file and answered into the edit's own
 * result. The cheapest moment there is: the model still has the file in mind, the fix is one more edit, and
 * nothing else has been built on the mistake yet.
 *
 * WHY A RULE AND NOT A HOOK IN THE WORKSPACE'S .claude DIRECTORY, which is where this repository's per-edit
 * linter and byte scan used to live. Those hooks listened on `Edit|Write`, and the harness tells the model to
 * prefer `sed`, heredocs and scripts, so the two readers that could name a syntax error in a second never saw
 * the edits that were made the recommended way: a test file full of `\\"` reached main through them. The daemon
 * already knows what a shell command changed (agent/agent-shell-edits.ts snapshots the tree around every Bash
 * call, for the type diagnostics), so a rule here is fed by the tree and hears every edit whatever wrote it.
 * It is also visible: the settings screen lists it, its firings are counted, and an owner can turn it off.
 *
 * `{file}` IN THE COMMAND IS THE FILE, spelled the way the place the command runs in spells it: an anchored
 * turn's command runs inside its namespace, where the agent's own path IS the worktree; an unanchored one runs
 * from the daemon, where the worktree path is the real one (the same split agent-diagnostics.ts makes for the
 * type check). The rule's `when.paths` is matched against the workspace-relative path, the same relativisation
 * every other moment applies, whichever of the file's two names arrived.
 *
 * ONLY A FAILURE SPEAKS. A command that exits 0 has nothing to say and says nothing, which is what keeps this
 * from being a line of noise on every save; what a failing one printed, the tail of it, is the whole message,
 * because the scripts written for this moment already say what to do. A command that could not run at all is
 * reported as that and never as a verdict about the file.
 *
 * ITS OWN CEILING, well under a rule's: a rule's `timeoutMs` is sized for a suite at the Stop, and a linter
 * that hangs for that long would stall a turn mid-thought. Sixty seconds is far past what any per-edit reader
 * needs and short enough that a wedged one costs one edit's patience. */

// What one rule's command said about one file. `error` means it never ran, and so has judged nothing.
export interface EditCommandRun {
    readonly status: "passed" | "failed" | "error";
    readonly output: string;
}

// Run one shell line for this moment. Injected so the hook set is testable without a shell, and so the planner
// can place it where the turn's files are (an anchored turn's namespace).
export type EditCommandRunner = (command: string, timeoutMs: number) => Promise<EditCommandRun>;

export const EDIT_COMMAND_CEILING_MS = 60_000;
// How much of a failing command's tail rides back. The scripts written for this moment already keep to a screen.
const OUTPUT_BYTES = 4_000;
const FILE_TOKEN = "{file}";

// A path, single-quoted for a POSIX shell, so a file named with a space or a quote is still one argument.
const shellQuoted = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

export interface FileEditedDeps {
    readonly run: EditCommandRunner;
    /* The roots a file's path may sit under, first match wins: the worktree the daemon sees, the root the agent
     * names it by, the workspace itself. A path is relativised against whichever it is under, so `when.paths`
     * reads the same globs every other moment does whichever of a file's two names arrived. Absent ⇒ paths are
     * matched as they came. */
    readonly roots?: readonly string[] | undefined;
    // Where the command runs, the file may have a different name than the one the hook heard (see the header).
    // Absent ⇒ the name that arrived is the one substituted.
    readonly place?: ((file: string) => string) | undefined;
    readonly onFired?: ((rule: Rule) => void) | undefined;
}

const relativeTo = (file: string, roots: readonly string[] | undefined): string => {
    for (const root of roots ?? []) {
        const relative = workspaceRelative(file, root);
        if (relative !== file) {
            return relative;
        }
    }
    return file;
};

/* What every standing `file.edited` rule has to say about one file, or nothing: the common answer. Returned as
 * a reviewer the diagnostics hook set runs beside the type check (agent/agent-diagnostics.ts), after an edit
 * tool AND after a shell command that changed the file, so one reader hears both. */
export const fileEditedReviewer = (rules: readonly Rule[], deps: FileEditedDeps): ((file: string, how: string) => Promise<string | undefined>) | undefined => {
    const armed = standing(rules, "file.edited");
    if (armed.length === 0) {
        return undefined;
    }
    return async (file, how) => {
        const relative = relativeTo(file, deps.roots);
        const placed = deps.place === undefined ? file : deps.place(file);
        const notes: string[] = [];
        for (const rule of armed) {
            if (rule.action.kind !== "command" || !conditionHolds(rule.when, { paths: [relative] })) {
                continue;
            }
            const command = rule.action.command.replaceAll(FILE_TOKEN, shellQuoted(placed));
            const run = await deps.run(command, Math.min(rule.action.timeoutMs, EDIT_COMMAND_CEILING_MS));
            if (run.status === "passed") {
                continue;
            }
            deps.onFired?.(rule);
            const output = run.output.trim().slice(-OUTPUT_BYTES);
            notes.push(
                run.status === "error"
                    ? `"${rule.label}" could not run on ${relative} after ${how} (\`${rule.action.command}\`): ${output}. That is not a verdict on the file.`
                    : `"${rule.label}" on ${relative} after ${how}:\n${output}`,
            );
        }
        return notes.length === 0 ? undefined : notes.join("\n\n");
    };
};

/* The default runner: one bash line in a directory, killed at the ceiling, its combined output kept as plain
 * text. A plain child rather than the tmux window the Stop's command gets (rules/rule-command.ts): nobody
 * watches a linter run on one file, and a terminal per save would be a new window every few seconds. */
export const spawnEditCommand =
    (cwd: string): EditCommandRunner =>
    (command, timeoutMs) =>
        new Promise((resolve) => {
            let output = "";
            let timedOut = false;
            const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
            const keep = (chunk: Buffer): void => {
                output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_BYTES * 4);
            };
            child.stdout.on("data", keep);
            child.stderr.on("data", keep);
            const watchdog = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, timeoutMs);
            watchdog.unref();
            child.on("error", (error) => {
                clearTimeout(watchdog);
                resolve({ status: "error", output: error.message });
            });
            child.on("close", (code) => {
                clearTimeout(watchdog);
                if (timedOut) {
                    resolve({ status: "error", output: `did not finish within ${Math.round(timeoutMs / 1000)}s` });
                    return;
                }
                resolve({ status: code === 0 ? "passed" : "failed", output: plainText(output) });
            });
        });
