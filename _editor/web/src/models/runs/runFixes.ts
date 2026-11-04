import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract/schemas/run-targets";
import type { AgentFix } from "../fixes/agentFix";

// What a Fix with agent press asks about a run that would not start or did not stay up (agentFix.ts): a preview's dev
// server that exited, a start the sandbox refused, a run on one of the owner's computers that ended in failure, a
// run-targets file it could not read. A run happens in the owner's own tree (or is built from it), so the agent works
// there; only the file it could not read is a plain edit, made in a copy and reviewed. English, like every brief.

const terminalFact = (session: string): string =>
    `Its output is in the tmux session \`${session}\` (read it with \`tmux capture-pane -p -J -t ${session} -S -400\`).`;

/** A preview whose dev server ran and exited. */
export const devServerFix = (target: {
    readonly label: string;
    readonly repo: string | undefined;
    readonly runs: string | undefined;
    readonly session: string | undefined;
    readonly title: string;
}): AgentFix => ({
    title: target.title,
    repo: target.repo,
    command: target.runs,
    facts: [`It is the preview \`${target.label}\`.`, ...(target.session === undefined ? [] : [terminalFact(target.session)])],
    goal:
        `Find out why the dev server stopped, from its output, and fix the cause (a missing install, a broken config, an error in the code, a port in use). ` +
        `Then start it again the way it was started and confirm it stays up and answers.`,
    tree: `shared`,
});

/** A start the sandbox refused, in its own words. */
export const startRefusedFix = (failure: { readonly repo: string; readonly target: string; readonly reason: string; readonly title: string }): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    reason: failure.reason,
    facts: [`The run target is \`${failure.target}\`, declared in \`${RUN_TARGETS_FILE}\` or found by Start in the repository's own files.`],
    goal: `Find out why it could not start and fix the cause, then start it and confirm it stays up.`,
    tree: `shared`,
});

/** A run on one of the owner's computers that ended with a failing exit code. */
export const computerRunFix = (failure: {
    readonly repo: string;
    readonly target: string;
    readonly device: string;
    readonly exitCode: number;
    readonly command: string | undefined;
    readonly log: string;
    readonly title: string;
}): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    command: failure.command,
    output: failure.log,
    facts: [`The run target \`${failure.target}\` ran on my computer \`${failure.device}\` and exited with code ${failure.exitCode}.`],
    goal:
        `Find out from its log why it failed and fix the cause: in the repository if it is the code or its build, or on \`${failure.device}\` through its own tools if it is that machine. ` +
        `Then run it there again and confirm it works.`,
    tree: `shared`,
});

/** A run-targets file the sandbox could not read. */
export const runFileFix = (failure: { readonly repo: string; readonly reason: string; readonly title: string }): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    reason: failure.reason,
    facts: [`The file is \`${RUN_TARGETS_FILE}\` in this repository.`],
    goal: `Make the file valid again, keeping every target it means to declare; read the schema the error names rather than guessing at it.`,
    tree: `own`,
});
