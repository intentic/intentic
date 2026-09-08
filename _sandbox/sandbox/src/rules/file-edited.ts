import { spawn } from "node:child_process";
import type { Rule } from "@intentic/sandbox-contract";
import { plainText } from "@intentic/base/plain-text";
import { conditionHolds, standing } from "./rules.js";
import { workspaceRelative } from "./turn-ending.js";

// Runs every standing file.edited rule on a file the instant it is written, folding the result into that edit's
// response; fed by tree diffs rather than an Edit/Write hook, so it hears an edit whatever wrote it. Only a failing
// command speaks; its own ceiling is far under a rule's normal timeout, so a hang costs one edit, not a turn.

// What one rule's command said about one file; `error` means it never ran, so it judged nothing.
export interface EditCommandRun {
    readonly status: "passed" | "failed" | "error";
    readonly output: string;
}

// One shell line for this moment, injected so it is testable without a shell and placeable in the turn's namespace.
export type EditCommandRunner = (command: string, timeoutMs: number) => Promise<EditCommandRun>;

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

// Default runner: one bash line in a directory, killed at the ceiling, output captured as plain text.
// A plain child, not a tmux window like rule-command.ts's Stop command: nobody watches a linter run on one file.
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
