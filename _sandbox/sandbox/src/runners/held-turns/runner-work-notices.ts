import type { RunnerSyncWork } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";

/* WHAT A RUNNER'S SYNC DID WITH A CONVERSATION'S WORK, SAID IN THE CONVERSATION (2026-11-24). A runner reports work the
   parent never received, and what it did with it, on its sync lines (RunnerSyncWork), which go to the log; these are the
   words the conversation's own transcript shows for each. Before them, the line saying where ginger-v2nz's edits to 176
   files had gone was in the daemon log only, while its transcript said "Work so far is kept", and the next conversation
   found them by hand on the runner's disk. No ref name is said: a commit and a command to put it back are what a person
   or an agent can act on. */

export interface WorkNotice {
    readonly level: "info" | "warning";
    readonly text: string;
}

// Long enough never to be ambiguous in one repo, short enough to read in a command.
const short = (sha: string): string => sha.slice(0, 12);

const filesWord = (files: number): string => (files === 1 ? "1 changed file" : `${files} changed files`);

const placeWord = (repo: string): string => (repo === "root" ? "the workspace root" : repo);

const gitIn = (repo: string): string => (repo === "root" ? "git" : `git -C ${repo}`);

const dateWord = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The words the conversation shows for one piece of work a runner's sync reported. Pure. */
export const workNotice = (work: RunnerSyncWork, runner: string): WorkNotice => {
    const files = filesWord(work.files);
    const place = placeWord(work.repo);
    if (work.kind === "carried") {
        return {
            level: "info",
            text: `The runner "${runner}" still held ${files} in ${place} that the last turn left there and never sent here. They are committed and carried into this turn, so nothing was lost.`,
        };
    }
    if (work.kind === "kept") {
        const moved = work.parentTip === undefined ? "" : ` (it was at ${short(work.parentTip)})`;
        return {
            level: "warning",
            text:
                `The runner "${runner}" still held ${files} in ${place} that never came here, and this conversation's branch here moved while it waited${moved} in a way they do not replay onto. ` +
                "The runner kept its own branch with them and works on it; when this turn's work comes back, it replaces that move here.",
        };
    }
    const when = work.at === undefined ? "" : ` on ${dateWord(work.at)}`;
    const restore =
        work.base === undefined
            ? `\`${gitIn(work.repo)} cherry-pick ${short(work.sha)}\``
            : `\`${gitIn(work.repo)} diff --binary ${short(work.base)} ${short(work.sha)} | ${gitIn(work.repo)} apply --3way\``;
    return {
        level: "warning",
        text:
            `${files} of this conversation's work, which an earlier build of the runner "${runner}" set aside${when} and never sent here, are here now as commit ${short(work.sha)} in ${place}. ` +
            `To put them back into its work, run this in its checkout here (move the conversation here first if it still runs on the runner): ${restore}`,
    };
};
