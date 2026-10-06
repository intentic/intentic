import type { Rule } from "@intentic/sandbox-contract";
import { plainText } from "@intentic/base/plain-text";
import { runCheck, shellArgv } from "../workload/run-check.js";
import { conditionHolds, reposOf, standing } from "./rules.js";
import { workspaceRelative } from "./workspace-relative.js";

// Runs every standing file.edited rule on a file the instant it is written, folding the result into that edit's
// response; fed by tree diffs rather than an Edit/Write hook, so it hears an edit whatever wrote it. Only a failing
// command speaks; its own ceiling is far under a rule's normal timeout, so a hang costs one edit, not a turn.

// What one rule's command said about one file; `error` means it never ran, so it judged nothing.
export interface EditCommandRun {
    readonly status: "passed" | "failed" | "error";
    readonly output: string;
}

// One shell line for this moment, injected so it is testable without a shell and placeable in the turn's namespace.
// `repo` is the rule's own, when it named one: the binder resolves it against the turn's tree, as at the other moments.
export type EditCommandRunner = (command: string, timeoutMs: number, repo?: string) => Promise<EditCommandRun>;

export const EDIT_COMMAND_CEILING_MS = 60_000;
// How much of a failing command's tail rides back in the message.
const OUTPUT_BYTES = 4_000;
const FILE_TOKEN = "{file}";

// Single-quotes the path for POSIX shells so spaces and embedded quotes stay one argument.
const shellQuoted = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

export interface FileEditedDeps {
    readonly run: EditCommandRunner;
    // Roots a path may sit under, first match wins; absent means paths are matched exactly as they arrived.
    readonly roots?: readonly string[] | undefined;
    // The command may need a different file name than the one this hook heard; absent uses the name as is.
    readonly place?: ((file: string) => string) | undefined;
    // The tree's repositories, for a rule aimed at one; absent leaves every such rule unmatched, the same answer a
    // workspace with no repositories gives.
    readonly repos?: (() => Promise<readonly string[]>) | undefined;
    readonly onFired?: ((rule: Rule) => void) | undefined;
    // Told how long each rule's command took on one file, whatever it found, for the perf log.
    readonly onRan?: ((rule: Rule, ms: number, status: EditCommandRun["status"]) => void) | undefined;
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

// Which repository a just-written file belongs to; undefined when nothing can say, which leaves a rule that names one
// unmatched rather than firing it against a repository nobody confirmed.
const repoOfFile = async (relative: string, repos: FileEditedDeps["repos"]): Promise<readonly string[] | undefined> =>
    repos === undefined ? undefined : reposOf([relative], await repos().catch((): readonly string[] => []));

// What a run that did not pass says to the model. An `error` never ran, so it is worded as a fact about the command
// rather than a verdict on the file: nobody should be sent to repair something nothing measured.
const noteOf = (rule: Rule, run: EditCommandRun, relative: string, how: string): string => {
    const output = run.output.trim().slice(-OUTPUT_BYTES);
    const command = rule.action.kind === "command" ? rule.action.command : "";
    return run.status === "error"
        ? `"${rule.label}" could not run on ${relative} after ${how} (\`${command}\`): ${output}. That is not a verdict on the file.`
        : `"${rule.label}" on ${relative} after ${how}:\n${output}`;
};

// What every standing file.edited rule says about one file, or nothing.
// Runs beside the type check in the diagnostics hook set, after both an edit tool and a shell command that changed the
// file.
export const fileEditedReviewer = (
    rules: readonly Rule[],
    deps: FileEditedDeps,
): ((file: string, how: string) => Promise<string | undefined>) | undefined => {
    const armed = standing(rules, "file.edited");
    if (armed.length === 0) {
        return undefined;
    }
    // Asked once, and only where a rule here actually names a repository: every other workspace pays nothing for this.
    const aimed = armed.some((rule) => rule.when?.repo !== undefined);
    return async (file, how) => {
        const relative = relativeTo(file, deps.roots);
        const placed = deps.place === undefined ? file : deps.place(file);
        const repos = aimed ? await repoOfFile(relative, deps.repos) : undefined;
        // Every matching rule at once, reported in the rules' order: an edit waits for the slowest command, not the sum.
        const notes = await Promise.all(
            armed.map(async (rule): Promise<string | undefined> => {
                if (rule.action.kind !== "command" || !conditionHolds(rule.when, { paths: [relative], repos })) {
                    return undefined;
                }
                const command = rule.action.command.replaceAll(FILE_TOKEN, shellQuoted(placed));
                // In the repository it named, like every other moment; the file itself travels as an absolute path, so the
                // working directory changes where the command runs without changing what it is given.
                const from = performance.now();
                const run = await deps.run(command, Math.min(rule.action.timeoutMs, EDIT_COMMAND_CEILING_MS), rule.when?.repo);
                deps.onRan?.(rule, performance.now() - from, run.status);
                if (run.status === "passed") {
                    return undefined;
                }
                deps.onFired?.(rule);
                return noteOf(rule, run, relative, how);
            }),
        );
        const said = notes.filter((note) => note !== undefined);
        return said.length === 0 ? undefined : said.join("\n\n");
    };
};

// Default runner: one bash line in a directory, killed at the ceiling, output captured as plain text.
// A child of the daemon, not a tmux window like the push run's (rule-command.ts): nobody watches a linter run on one file.
// Classed as an agent's command (workload/workload-class.ts), since it is work done on the agent's behalf: without a
// class it would keep the daemon's own rank and outlive a turn's runtime under the OOM killer. In a process group of its
// own, so the ceiling kills the tsc or vitest the line started along with its shell; killing the shell alone left them
// running, holding the output pipe and with it the edit's answer.
export const spawnEditCommand =
    (cwd: string): EditCommandRunner =>
    async (command, timeoutMs) => {
        const ran = await runCheck({
            argv: shellArgv(command, "bash"),
            cwd,
            timeoutMs,
            workload: { class: "command" },
            kind: "edit-rule",
            // The tail is what names a failure; a rolling window past it keeps memory flat for a chatty linter.
            captureBytes: OUTPUT_BYTES * 4,
            keep: "tail",
            interleave: true,
        });
        if (ran.spawnError !== undefined) {
            return { status: "error", output: ran.spawnError };
        }
        if (ran.ended === "timeout") {
            return { status: "error", output: `did not finish within ${Math.round(timeoutMs / 1000)}s` };
        }
        return { status: ran.exitCode === 0 ? "passed" : "failed", output: plainText(ran.stdout) };
    };
