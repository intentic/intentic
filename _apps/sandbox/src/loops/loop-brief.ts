import { type Loop, LOOP_DIR } from "@intentic/sandbox-contract";

/* WHAT AN ITERATION IS TOLD — the loop's whole specialization surface.
 *
 * The daemon has exactly one per-conversation seam, the turn's PROMPT (the system prompt is sandbox-wide), so
 * everything a loop needs to say it says here. That is not a limitation: all of it is task instruction, which
 * is what a prompt is for. Same reasoning the acceptance brief opens with.
 *
 * Four things it has to get right, and three of them only matter because the loop repeats:
 *
 * 1. THE GOAL IS RESTATED EVERY TIME, above the instruction. In `fresh` mode the model has never seen it
 *    before; in `continue` mode it saw it fifteen turns ago, behind a wall of tool output. Neither one is a
 *    model that can be assumed to still know what it is working towards.
 *
 * 2. THE ITERATION IS NUMBERED, out loud. "Iteration 7 of 12" is the one piece of context that changes the
 *    work: an agent three from the ceiling should be consolidating rather than opening a new front, and it can
 *    only know that if it is told. It also stops the loop reading as déjà vu in `continue` mode, where the
 *    model would otherwise see its own near-identical prompt arrive again and reasonably conclude the user is
 *    repeating themselves because the last answer was wrong.
 *
 * 3. IN `fresh` MODE THE PROGRESS FILE IS THE ONLY MEMORY, so it is named before the work and demanded after
 *    it. This is the whole mechanism of a Ralph loop: the transcript is thrown away every iteration and the
 *    filesystem carries the state. A fresh iteration that does not read the file repeats the previous one's
 *    dead end, and one that does not write it condemns the next iteration to the same.
 *
 * 4. WHAT ENDS THE LOOP IS SAID PLAINLY. An agent told "make the tests pass" that does not know a command is
 *    being run against it optimizes for sounding finished; told the exact command, it runs it. This is the
 *    cheapest quality win in the file and it costs one sentence.
 */

// The loop's own directory, as the AGENT sees it. Absolute /work paths, like the acceptance brief's: an
// isolated turn's worktree is bind-mounted over /work with `.intentic` bound back in SHARED, so this one
// spelling reaches the same directory from inside a worktree, from the main tree, and from the daemon.
export const loopDirFor = (conversationId: string): string => `/work/${LOOP_DIR}/${conversationId}`;
export const progressPathFor = (conversationId: string): string => `${loopDirFor(conversationId)}/progress.md`;
export const verdictPathFor = (conversationId: string, iteration: number): string => `${loopDirFor(conversationId)}/iteration-${iteration}.json`;

// The stop condition, in the agent's terms. `claim` is handled separately (it needs the verdict file's shape,
// which is a section of its own); these two are one line each because the agent's job is only to know what it
// is being measured by.
const stopNote = (loop: Loop): string | undefined => {
    if (loop.stop.kind === "command") {
        return (
            `This loop ends when \`${loop.stop.command}\` exits 0. That command is run for you after every iteration — ` +
            `run it yourself to check your work, and do not edit it, skip it, or weaken what it asserts to make it pass.`
        );
    }
    if (loop.stop.kind === "judge") {
        return (
            `When this iteration ends, a separate reviewer — one that did none of this work and cannot see your ` +
            `reasoning, only what you wrote down — decides whether the goal is met, against this rubric:\n\n` +
            `> ${loop.stop.rubric}\n\n` +
            `So make the evidence legible: say what you changed and how you verified it, in your final message.`
        );
    }
    return undefined;
};

// The `claim` stop's contract. The verdict is a FILE rather than a sentence in the reply for the reason every
// structured output in this codebase is a file: a reply has to be parsed out of prose that the model is also
// using to talk to a human, and the two demands pull against each other. A file has one job.
const claimNote = (loop: Loop, iteration: number): string =>
    [
        `## Before you finish: the verdict file`,
        ``,
        `Write \`${verdictPathFor(loop.conversationId, iteration)}\` — exactly this shape, and nothing else in the file:`,
        ``,
        `\`\`\`json`,
        JSON.stringify(
            { done: false, reason: "one line: why the goal is or is not met yet", evidence: "what you checked to know that" },
            undefined,
            2,
        ),
        `\`\`\``,
        ``,
        `\`done\` is \`true\` ONLY if the goal above is fully met right now — not "nearly", not "met once the ` +
            `remaining item is handled". If it is not met, say in \`reason\` what is left, because the next ` +
            `iteration reads that line first.`,
        ``,
        `Write it even when the iteration went badly. A missing verdict is read as "not done", which wastes an ` +
            `iteration on work you may have already finished.`,
    ].join(`\n`);

// The memory rule for `fresh` mode. Not sent in `continue` mode: there the transcript is the memory, and a
// second bookkeeping surface would only compete with it for the model's attention.
const progressNote = (loop: Loop): string =>
    [
        `## Your memory between iterations`,
        ``,
        `Each iteration of this loop is a FRESH session. You cannot remember the last one and the next one ` +
            `cannot remember you. \`${progressPathFor(loop.conversationId)}\` is what carries across — it, and the ` +
            `state of the working tree.`,
        ``,
        `So: **read that file before you do anything else**, and **update it before you finish**. Keep it short and ` +
            `factual — what is done, what is left, what you tried that did not work and must not be tried again. ` +
            `That last one is what stops a loop going round in circles.`,
    ].join(`\n`);

export const briefForIteration = (loop: Loop, iteration: number): string => {
    const stop = stopNote(loop);
    const sections = [
        [
            `# Iteration ${iteration} of at most ${loop.maxIterations}`,
            ``,
            `You are one iteration of a loop that repeats until a goal is met. The goal:`,
            ``,
            `> ${loop.goal}`,
        ].join(`\n`),
        [`## This iteration's task`, ``, loop.prompt].join(`\n`),
        ...(loop.context === `fresh` ? [progressNote(loop)] : []),
        ...(stop !== undefined ? [[`## How this loop ends`, ``, stop].join(`\n`)] : []),
        ...(loop.stop.kind === `claim` ? [claimNote(loop, iteration)] : []),
        // Last, because it is the instruction most likely to be overridden by everything above it if it is not
        // the final word. An agent that "finishes" by declaring the goal met without touching the tree is the
        // stall the detector exists to catch — better to say so than to catch it three iterations later.
        [
            `## Make this iteration count`,
            ``,
            `Do real work now. Do not plan the loop, do not summarize what a future iteration should do, and do not ` +
                `stop early to "check in" — there is nobody to check in with, and an iteration that changes nothing is ` +
                `a wasted turn that counts against the loop's budget. If the goal is already met, say so plainly and ` +
                `change nothing.`,
        ].join(`\n`),
    ];
    return sections.join(`\n\n`);
};
