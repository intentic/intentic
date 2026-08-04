import { join } from "node:path";
import { fieldsExample, type Loop, LOOP_DIR } from "@intentic/sandbox-contract";

/* WHAT A TURN IS TOLD — the loop's whole specialization surface.
 *
 * The daemon has exactly one per-conversation seam, the turn's PROMPT (the system prompt is sandbox-wide), so
 * everything a loop needs to say it says here. That is not a limitation: all of it is task instruction, which
 * is what a prompt is for. Same reasoning the acceptance brief opens with.
 *
 * IT DESCRIBES A GOAL, NEVER THE MACHINERY THAT PURSUES IT. This file used to open every message with
 * "# Iteration 3 of at most 20 — you are one iteration of a loop that repeats until a goal is met", and close
 * it with a paragraph about not wasting the loop's budget. All of that is TRUE, and none of it is the job. A
 * model handed a page about the harness it is running inside spends attention on the harness; worse, the
 * numbers in it are the daemon's bookkeeping, so a workflow step that only ever ran once opened by announcing a
 * ceiling of twenty it could not approach. What is left is the shape of any ordinary request somebody makes of
 * an agent: here is the work, here is what done means, here is what will be checked.
 *
 * WHAT SURVIVED, and each one is a MECHANISM the model has to operate rather than a description of the loop:
 *
 * 1. THE GOAL, under the work rather than over it — the user's own words open the message. Restated at all
 *    because in `fresh` mode this session has never seen it, and in `continue` mode it saw it fifteen turns ago
 *    behind a wall of tool output. Skipped when the prompt already contains it, which is the ordinary case for
 *    a workflow step measured against the request it was handed verbatim: a goal quoted back under the sentence
 *    it was copied from reads as a second, subtly different instruction.
 *
 * 2. IN `fresh` MODE THE PROGRESS FILE IS THE ONLY MEMORY, so it is named before the work and demanded after
 *    it. This is the whole mechanism of a Ralph loop: the transcript is thrown away and the filesystem carries
 *    the state. A session that does not read the file repeats the last one's dead end, and one that does not
 *    write it condemns the next to the same.
 *
 * 3. WHAT DECIDES IT IS DONE IS SAID PLAINLY, all of it — the document to write AND every check that will be
 *    run. An agent told "make the tests pass" that does not know a command is being run against it optimizes
 *    for sounding finished; told the exact command, it runs it. This is the cheapest quality win in the file
 *    and it costs one sentence per check.
 */

// The loop's directory under a given tree root. `root` is `/work` when the sentence is going to an AGENT and
// the daemon's real workspace root when the daemon is going to open the file itself — the same directory
// either way, because an isolated turn's worktree is bind-mounted over /work with `.intentic` bound back in
// SHARED, so this one spelling reaches it from inside a worktree, from the main tree, and from the daemon.
export const loopDirIn = (root: string, conversationId: string): string => join(root, LOOP_DIR, conversationId);
export const progressPathIn = (root: string, conversationId: string): string => join(loopDirIn(root, conversationId), `progress.md`);
export const verdictPathIn = (root: string, conversationId: string, iteration: number): string =>
    join(loopDirIn(root, conversationId), `iteration-${iteration}.json`);

// The workspace root as every agent sees it, whatever tree it is actually working in.
const AGENT_ROOT = `/work`;

// Each check, in the agent's terms. One line each, because the agent's job is only to know what it is being
// measured by — and knowing is most of it.
const checkNote = (loop: Loop): string | undefined => {
    const notes = loop.checks.map((check) =>
        check.kind === `command`
            ? `\`${check.command}\` is run for you once you finish, and this is not done until it exits 0. ` +
              `Run it yourself to check your work, and do not edit it, skip it, or weaken what it asserts to make it pass.`
            : `A separate reviewer — one that did none of this work and cannot see your reasoning, only what you wrote ` +
              `down — will decide whether the goal is met, against this rubric:\n\n> ${check.rubric}\n\n` +
              `So make the evidence legible: say what you changed and how you verified it, in your final message.`,
    );
    if (notes.length === 0) {
        return undefined;
    }
    return notes.length === 1 ? notes[0] : notes.map((note) => `- ${note}`).join(`\n`);
};

/* The output contract. A FILE rather than a sentence in the reply for the reason every structured output in
 * this codebase is a file: a reply has to be parsed out of prose the model is also using to talk to a human,
 * and the two demands pull against each other until neither is served. A file has one job.
 *
 * The example is generated from the declared fields rather than described in a legend, so the model reads each
 * field's meaning in the slot it is about to fill rather than three lines above it.
 */
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
        `Write \`${verdictPathIn(AGENT_ROOT, loop.conversationId, iteration)}\` — exactly this shape, and nothing else in the file:`,
        ``,
        `\`\`\`json`,
        JSON.stringify(shape, undefined, 2),
        `\`\`\``,
        ``,
        ...(loop.output.kind === `json`
            ? [
                  `Every string above is a DESCRIPTION of what belongs there, not a value to copy. \`data\` is what the ` +
                      `next step of this job receives — it is read by a program, so the keys and types have to be exactly ` +
                      `as shown, and a field you fill with a guess is worse than one you leave out.`,
                  ``,
              ]
            : []),
        `\`done\` is \`true\` ONLY if the goal is fully met right now — not "nearly", not "met once the ` +
            `remaining item is handled". If it is not met, say in \`reason\` what is left: that line is what ` +
            `whoever picks this up next reads first.`,
        ``,
        `Write it even when the work went badly. A missing file is read as "not done", which costs another ` +
            `session on work you may have already finished.`,
    ].join(`\n`);
};

// The memory rule for `fresh` mode. Not sent in `continue` mode: there the transcript is the memory, and a
// second bookkeeping surface would only compete with it for the model's attention. Written as what it is — a
// file that is this session's only memory — rather than as an explanation of the harness that arranged that.
const progressNote = (loop: Loop): string =>
    [
        `## Your memory`,
        ``,
        `This session cannot see anything that came before it and nothing carries out of it except the working ` +
            `tree and one file: \`${progressPathIn(AGENT_ROOT, loop.conversationId)}\`.`,
        ``,
        `So: **read that file before you do anything else**, and **update it before you finish**. Keep it short and ` +
            `factual — what is done, what is left, what you tried that did not work and must not be tried again. ` +
            `That last one is what stops the same dead end being walked into twice.`,
    ].join(`\n`);

/* NOTHING TO PRODUCE AND NOTHING TO CHECK, so it ends when its first turn ends.
 *
 * That is not a guess about the configuration, it is what loop-stop.ts does: `readDocument` answers `done` for
 * a `none` output without reading anything, and with no checks to AND against it `evaluateStop` returns done on
 * iteration 1. There is never a second turn.
 *
 * Which makes every section below furniture for it: the goal restated is the prompt restated, the progress file
 * is memory for a successor that does not exist, and there is nothing to check. A workflow step written as "do
 * what I asked" is exactly this shape, and the message it gets is the sentence the user typed.
 */
const singleTurn = (loop: Loop): boolean => loop.output.kind === `none` && loop.checks.length === 0;

export const briefForIteration = (loop: Loop, iteration: number): string => {
    // The prompt, and nothing else. Whatever the caller composed is the whole message.
    if (singleTurn(loop)) {
        return loop.prompt;
    }
    const checks = checkNote(loop);
    const output = outputNote(loop, iteration);
    return [
        loop.prompt,
        // A goal the prompt already carries is the same words twice — see the header. The ordinary case for a
        // workflow step, whose goal defaults to the very request it was handed.
        ...(loop.prompt.includes(loop.goal) ? [] : [[`## Done when`, ``, `> ${loop.goal}`].join(`\n`)]),
        ...(loop.context === `fresh` ? [progressNote(loop)] : []),
        ...(checks !== undefined ? [[`## What is checked`, ``, checks].join(`\n`)] : []),
        ...(output !== undefined ? [output] : []),
    ].join(`\n\n`);
};
