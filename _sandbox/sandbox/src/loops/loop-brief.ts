import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { fieldsExample, type Loop, LOOP_DIR } from "@intentic/sandbox-contract";

// Prompt content only: describes the goal and what will be checked, never the loop's own machinery (iteration count,
// budget, mode). The goal is restated only when the prompt doesn't already contain it; the progress-file memory note
// applies only in `fresh` mode.

// Loop directory under a root; `/work` for agent-facing text, the daemon's real root otherwise. Same path reaches a
// worktree, the main tree, or the daemon since `.intentic` is bind-mounted shared.
export const loopDirIn = (root: string, conversationId: string): string => join(root, LOOP_DIR, conversationId);
const progressPathIn = (root: string, conversationId: string): string => join(loopDirIn(root, conversationId), `progress.md`);
export const verdictPathIn = (root: string, conversationId: string, iteration: number): string =>
    join(loopDirIn(root, conversationId), `iteration-${iteration}.json`);

// The workspace root as every agent sees it, whatever tree it is actually working in.
const AGENT_ROOT = WORKSPACE_ROOT;

// Renders each check in the agent's terms, one line each: knowing what it's measured by is most of the job.
const checkNote = (loop: Loop): string | undefined => {
    const notes = loop.checks.map((check) =>
        check.kind === `command`
            ? `\`${check.command}\` is run for you once you finish, and this is not done until it exits 0. ` +
              `Run it yourself to check your work, and do not edit it, skip it, or weaken what it asserts to make it pass.`
            : `A separate reviewer (one that did none of this work and cannot see your reasoning, only what you wrote ` +
              `down) will decide whether the goal is met, against this rubric:\n\n> ${check.rubric}\n\n` +
              `So make the evidence legible: say what you changed and how you verified it, in your final message.`,
    );
    if (notes.length === 0) {
        return undefined;
    }
    return notes.length === 1 ? notes[0] : notes.map((note) => `- ${note}`).join(`\n`);
};

// Output goes to a file, not the reply text, since a reply mixes structured output with prose aimed at a human. The
// example JSON is generated from the declared fields so each slot's meaning sits where it is filled.
const outputNote = (loop: Loop, iteration: number): string | undefined => {
    if (loop.output.kind === `none`) {
        return undefined;
    }
    const shape = {
        done: false,
        reason: `one line: why the goal is or is not met yet`,
        evidence: `what you checked to know that`,
        ...(loop.output.kind === `json` ? { data: fieldsExample(loop.output.fields) } : {}),
    };
    return [
        `## Before you finish: the output file`,
        ``,
        `Write \`${verdictPathIn(AGENT_ROOT, loop.conversationId, iteration)}\` in exactly this shape, and nothing else in the file:`,
        ``,
        `\`\`\`json`,
        JSON.stringify(shape, undefined, 2),
        `\`\`\``,
        ``,
        ...(loop.output.kind === `json`
            ? [
                  `Every string above is a DESCRIPTION of what belongs there, not a value to copy. \`data\` is what the ` +
                      `next step of this job receives. It is read by a program, so the keys and types have to be exactly ` +
                      `as shown, and a field you fill with a guess is worse than one you leave out.`,
                  ``,
              ]
            : []),
        `\`done\` is \`true\` ONLY if the goal is fully met right now, not "nearly", not "met once the ` +
            `remaining item is handled". If it is not met, say in \`reason\` what is left: that line is what ` +
            `whoever picks this up next reads first.`,
        ``,
        `Write it even when the work went badly. A missing file is read as "not done", which costs another ` +
            `session on work you may have already finished.`,
    ].join(`\n`);
};

// Memory rule for `fresh` mode only; in `continue` mode the transcript already is the memory, and a second surface
// would only compete for attention.
const progressNote = (loop: Loop): string =>
    [
        `## Your memory`,
        ``,
        `This session cannot see anything that came before it and nothing carries out of it except the working ` +
            `tree and one file: \`${progressPathIn(AGENT_ROOT, loop.conversationId)}\`.`,
        ``,
        `So: **read that file before you do anything else**, and **update it before you finish**. Keep it short and ` +
            `factual: what is done, what is left, what you tried that did not work and must not be tried again. ` +
            `That last one is what stops the same dead end being walked into twice.`,
    ].join(`\n`);

// Nothing to produce and nothing to check: loop-stop.ts's evaluateStop returns done after iteration 1, so there is
// never a second turn.
const singleTurn = (loop: Loop): boolean => loop.output.kind === `none` && loop.checks.length === 0;

export const briefForIteration = (loop: Loop, iteration: number): string => {
    // Prompt only; whatever the caller composed is the entire message.
    if (singleTurn(loop)) {
        return loop.prompt;
    }
    const checks = checkNote(loop);
    const output = outputNote(loop, iteration);
    return [
        loop.prompt,
        // Skipped when the prompt already carries the goal verbatim, the ordinary case for a workflow step.
        ...(loop.prompt.includes(loop.goal) ? [] : [[`## Done when`, ``, `> ${loop.goal}`].join(`\n`)]),
        ...(loop.context === `fresh` ? [progressNote(loop)] : []),
        ...(checks !== undefined ? [[`## What is checked`, ``, checks].join(`\n`)] : []),
        ...(output !== undefined ? [output] : []),
    ].join(`\n\n`);
};
