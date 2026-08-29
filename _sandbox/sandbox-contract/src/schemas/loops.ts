// loops: run a conversation again, and again, until a goal is met
import { z } from "zod";
import { STATE_DIR } from "@intentic/constants";
import { OutputFieldsSchema } from "../output-fields.js";
import { AgentHarnessSchema, AgentProviderSchema, ConversationIdSchema, RepoBaseSchema } from "./agent.js";
import { entryId } from "./internal.js";
/* THE RALPH LOOP. An automation answers "run this at 3am"; a loop answers "run this until it is actually done".
 * The two are the opposite question and neither substitutes for the other: a schedule repeats on CADENCE and
 * never converges, a loop repeats on CONVERGENCE and stops the moment its goal is met.
 *
 * A loop is an ATTRIBUTE OF A CONVERSATION, not a new kind of object. It drives ordinary turns on an ordinary
 * fleet agent, which is what makes the worktree, the cost ledger, the transcript, the /agents card and the Stop
 * button work on it without a line of new code, the same bet the acceptance extension makes when it derives
 * conversation ids instead of owning session machinery.
 */

// How the next iteration meets its context, and the single most consequential field here.
//
// `fresh` is the canonical Ralph and the default: each iteration is a NEW provider session against the SAME
// worktree, so the filesystem, not the transcript, is the memory. Immune to context rot, so iteration 20 reads
// the tree as clearly as iteration 1, and it costs a re-read each time. The loop keeps a progress file for it
// (see LOOP_DIR) precisely because nothing else carries forward.
//
// `continue` resumes the provider session, so an iteration is a follow-up prompt. Cheaper (the prefix caches)
// and it keeps the reasoning, which is what a short refine-this loop wants. It degrades on long runs, and it
// degrades in the direction that matters: a session that has spent eleven turns arguing for its own approach is
// the worst available judge of whether that approach is finished.
export const LoopContextSchema = z.enum(["fresh", "continue"]);
export type LoopContext = z.infer<typeof LoopContextSchema>;
/* WHAT THE LOOP PRODUCES, asked separately from what ends it, because they are separate questions and
 * conflating them is what makes a chain of sessions impossible to build.
 *
 * `none`, the loop produces nothing but its work. The classic "make the suite green": what it leaves behind
 *   is a green suite, and asking it to also file a report is asking it to spend a turn on paperwork.
 * `claim`, the iteration writes `{done, reason, evidence?}`. Prose, but STRUCTURED prose: `done` is a boolean
 *   the daemon reads rather than a sentence it has to interpret. Self-assessment, so advisory by construction,
 *   it exists because plenty of goals have no command that can check them ("the README explains the auth
 *   flow"), not because a model's word for it is worth much.
 * `json`, the iteration writes `{done, reason, data}` where `data` matches a declared field list. This is the
 *   one that makes a step's output usable as the next step's input: a paragraph mentioning three files cannot
 *   be fed to anything, `{files: [...]}` can.
 *
 * All three land in ONE file per iteration, with one shape, differing only in strictness. See LoopDocumentSchema.
 */
export const LoopOutputSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z
            .literal("none")
            .describe(
                "It produces nothing but its work. The classic make the suite pass: what it leaves behind is a passing suite, and asking it to also file a report is asking it to spend a round on paperwork.",
            ),
    }),
    z.object({
        kind: z
            .literal("claim")
            .describe(
                "Each round says whether it is done and why. Structured prose: done is a value read rather than a sentence interpreted. Self-assessment, so advisory by construction; it exists because plenty of goals have no command that could check them.",
            ),
    }),
    z.object({
        kind: z
            .literal("json")
            .describe(
                "Each round writes a real answer in a shape you declared. This is the one that makes a step's output usable as the next step's input: a paragraph mentioning three files cannot be fed to anything, a list of three files can.",
            ),
        fields: OutputFieldsSchema.describe("The shape that answer has to match."),
    }),
]);
export type LoopOutput = z.infer<typeof LoopOutputSchema>;
/* WHAT ELSE HAS TO BE TRUE, checks that are not the worker's own word, ANDed with the output above.
 *
 * `command` is a shell one-liner run in the conversation's tree; exit 0 ⇒ satisfied. Deterministic, free, and
 * the only signal here whose answer does not come from a model. It is the automation `guard` with the sign
 * flipped, and it runs through the same runner. `pnpm test` passing beats any amount of self-report.
 *
 * `judge` puts a SEPARATE, tool-less call on the question: it reads the iteration's own report and rules
 * against a rubric, having done none of the work and nothing invested in it being finished.
 *
 * The rule both encode, and the reason they are kept apart from the output: the check must be a DIFFERENT CALL
 * from the work, or it is not a check. An output is what the worker says; a check is what someone else says.
 */
export const LoopCheckSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z
            .literal("command")
            .describe(
                "Run something and see if it passes. Deterministic, free, and the only signal here whose answer does not come from a model. A passing test suite beats any amount of self-report.",
            ),
        command: z.string().min(1).describe("The command to run in the conversation's own tree. Exiting cleanly means satisfied."),
    }),
    // The rubric is what the judge is asked; absent `model` runs it on the quick rung the other helpers use.
    z.object({
        kind: z
            .literal("judge")
            .describe(
                "Put the question to a separate model with no tools, which reads the round's own report and rules on it, having done none of the work and nothing invested in its being finished.",
            ),
        rubric: z.string().min(1).describe("What that judge is asked."),
        model: z.string().optional().describe("Which model judges. Leave it out for the cheap one the other small jobs use."),
    }),
]);
export type LoopCheck = z.infer<typeof LoopCheckSchema>;
/* THE VERDICT FILE an iteration writes, one shape for all three output kinds, because the loop reads it the
 * same way whatever was declared and only the validation of `data` differs.
 *
 * It is a FILE rather than a sentence in the reply for the reason every structured output in this codebase is
 * a file: a reply has to be parsed out of prose the model is simultaneously using to talk to a person, and the
 * two demands pull against each other until neither is served. A file has one job.
 */
export const LoopDocumentSchema = z.object({
    // Whether the goal is met NOW. The loop's own reading of this is the whole point of the file.
    done: z.boolean().describe("Whether the goal is met. Reading this is the whole point of the file."),
    // One line: why it is or is not met. The single most-read string in the feature, it is what the next
    // iteration reads first and what the history row shows.
    reason: z.string().describe("Why, in one line. The most-read sentence in the feature: the next round reads it first and the history shows it."),
    // What the iteration checked to know that. Optional because a model with nothing to point at should say so
    // by omitting it rather than by inventing a sentence.
    evidence: z
        .string()
        .optional()
        .describe(
            "What was checked to know that. Optional, so a round with nothing to point at says so by leaving it out rather than by inventing a sentence.",
        ),
    // The declared fields, present only for a `json` output and validated against them there.
    data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The declared answer, for a loop that asked for one, checked against the shape it declared."),
});
export type LoopDocument = z.infer<typeof LoopDocumentSchema>;
// Enough iterations for a real convergence, few enough that a misconfigured loop is a bounded mistake. A loop
// that has not converged in 50 turns is not one iteration short of it.
const LOOP_ITERATIONS_MAX = 50;
export const LoopSchema = z.object({
    // The conversation the loop drives, its fleet card, its worktree, its transcript.
    conversationId: ConversationIdSchema.describe(
        "The conversation to loop. It need not exist yet: naming a fresh one opens it, which is what lets run this until it passes be the first thing you ever say.",
    ),
    // What "done" means, in the user's words. Rides into every iteration's prompt (and into the judge's
    // question) so the model is told the goal it is being measured against rather than left to infer it.
    goal: z
        .string()
        .min(1)
        .describe(
            "What done means, in your words. It goes into every round's instructions and into the judge's question, so the model is told the bar rather than left to infer it.",
        ),
    // What each iteration is asked to DO. Separate from `goal` because they are different sentences: "make the
    // suite green" is the goal, "run the tests, pick the top failure, fix it" is the instruction.
    prompt: z
        .string()
        .min(1)
        .describe("What each round is asked to do. The suite passes is the goal; run the tests, take the top failure, fix it is the instruction."),
    context: LoopContextSchema.describe(
        "How each round meets the last. Starting fresh makes the files the memory rather than the conversation, so the twentieth round reads the tree as clearly as the first, and costs a re-read each time. Carrying on is cheaper and keeps the reasoning, which suits a short polish-this loop and degrades on long ones: a session that has spent eleven rounds arguing for its own approach is the worst available judge of whether that approach is finished.",
    ),
    output: LoopOutputSchema,
    /* Everything besides the worker's own word that has to hold before the loop may end. Ordinarily one or
     * none; a list because "the suite is green AND the report is written" is a real completion bar and
     * expressing it as two loops would run the work twice. */
    checks: z
        .array(LoopCheckSchema)
        .describe(
            "What else has to be true, all of them together. A list because the suite passes and the report is written is a real bar, and running it as two loops would do the work twice.",
        ),
    maxIterations: z
        .number()
        .int()
        .min(1)
        .max(LOOP_ITERATIONS_MAX)
        .describe("How many rounds before it gives up. A loop that has not got there in fifty is not one round short of it."),
    // The spend ceiling in USD across the whole loop, summed from the turns' own usage frames. Optional because
    // a 3-iteration loop does not need one; strongly wanted on anything unattended, since this is the first
    // feature in the sandbox that can spend without a person pressing anything between turns.
    maxSpendUsd: z
        .number()
        .positive()
        .optional()
        .describe(
            "A ceiling on what the whole loop may spend, in dollars. Optional for a short loop somebody is watching, and strongly wanted otherwise: this is the first thing here that can keep spending with nobody pressing anything between rounds.",
        ),
    /* Stop after this many CONSECUTIVE iterations that changed nothing in the tree.
     *
     * The guard that matters most in practice, and the one whose absence is expensive. The failure mode of a
     * loop is not runaway success, it is an agent that re-reads the same three files, restates the same plan,
     * declares more work remains, and does that eleven times. Nothing about that is an error, every turn
     * succeeds, so only "the tree did not move" catches it. */
    stallLimit: z
        .number()
        .int()
        .min(1)
        .describe(
            "Stop after this many rounds in a row that changed nothing on disk. The guard that matters most: a loop's failure is not runaway success, it is an agent re-reading the same three files, restating the same plan and declaring more work remains, eleven times. Every one of those rounds succeeds, so only the tree not moving catches it.",
        ),
    // Whether the iterations run in the conversation's own worktree or on the shared tree. Recorded on the loop
    // rather than read off the conversation because a loop can OPEN one, and because it decides where the stop
    // command runs: a check against /work would be testing code an isolated loop has not landed yet.
    isolated: z
        .boolean()
        .describe(
            "Whether it works in the conversation's own private copy or in the shared tree. It also decides where a check runs: testing the shared tree would be testing code this loop has not merged yet.",
        ),
    // Which provider / harness / model the iterations run on; absent ⇒ the conversation's own last choice, then
    // the provider default. The same three passthroughs an automation carries, for the same reason: a headless
    // driver has no composer to read them from.
    agent: AgentProviderSchema.optional().describe("Which provider the rounds run on. Absent falls back to the conversation's own last choice."),
    harness: AgentHarnessSchema.optional().describe("Which agentic loop they run on."),
    account: z.string().optional().describe("Which account pays."),
    model: z.string().optional().describe("Which model."),
    // Which persona the iterations act as (AgentTurnSchema.actsAs, read its note for why this is not spelled
    // `account`). The fourth passthrough an automation carries, and it matters here for the automation's
    // reason: every iteration is unattended, and an unattended turn with no persona reaches no logged-in
    // account at all, pinning a card is the one way a loop gets hands.
    actsAs: entryId
        .optional()
        .describe(
            "Which persona the rounds act as. It matters here: every round is unwatched, and an unwatched turn naming no persona reaches no signed-in account at all, so pinning one is how a loop gets hands.",
        ),
    // A workflow persists these on its underlying loop so restart recovery cannot silently change the checkout
    // or let a candidate inherit the sandbox's global auto-land posture on a later iteration.
    worktreeBase: z
        .array(RepoBaseSchema)
        .min(1)
        .max(50)
        .optional()
        .describe("Pin the private copy to these exact commits, so a restart cannot quietly change what the loop is working on."),
    autoLand: z.boolean().optional().describe("Whether the work merges as it goes."),
});
export type Loop = z.infer<typeof LoopSchema>;
// Can this loop ever end on its own terms? A loop with nothing to produce and nothing to check runs to its
// iteration ceiling and reports `exhausted`, having been unable to succeed from the moment it was configured.
// A predicate rather than a schema refinement because two routes want it as one, at different moments: `start`
// refuses an ad-hoc loop, and `saveDesign` refuses a SAVED one, which is the more valuable of the two, since a
// saved loop that cannot converge is a trap everyone who picks it afterwards pays a full run to discover.
export const loopCanConverge = (loop: Pick<Loop, "output" | "checks">): boolean => loop.output.kind !== "none" || loop.checks.length > 0;
/* Where a loop keeps what it must not lose between iterations: <workspace>/.intentic/records/artifacts/loops/<conversationId>/.
 *
 * Under `.intentic` for the reason the acceptance runs are, it is outside every repo and bound back SHARED
 * into an isolated turn's worktree, so the agent writes and the browser reads the same tree, with nothing to
 * land and no git noise. `progress.md` is the loop's memory in `fresh` mode and its audit trail in `continue`
 * mode; `iteration-<n>.json` is the verdict a `claim` stop reads. */
export const LOOP_DIR = `${STATE_DIR}/records/artifacts/loops`;
// Why an iteration ended, which is not the same question as how the LOOP ended. `continue` is the ordinary
// "not done yet"; `error` is a turn that surfaced an error frame, which does NOT end the loop by itself, a
// failing turn is often exactly what the next iteration is supposed to fix.
export const LoopIterationSchema = z.object({
    n: z.number().int().min(1).describe("Which round this was."),
    at: z.number().describe("When it ran, in milliseconds."),
    outcome: z
        .enum(["continue", "done", "error"])
        .describe(
            "How the round ended, which is not the same question as how the loop did. A round that errored does not end the loop by itself: a failing turn is often exactly what the next round is meant to fix.",
        ),
    // The stop check's own words, the guard's output tail, the claim's reason, the judge's verdict. What the
    // run history is actually read for: "why did it keep going" and "why did it stop".
    detail: z
        .string()
        .optional()
        .describe("What the check said, in its own words. What a run history is actually read for: why it kept going, and why it stopped."),
    costUsd: z.number().optional().describe("What the round cost, in dollars."),
    // Whether the tree moved this iteration. Feeds the stall detector, and is worth showing per row: three
    // unchanged iterations in a history is the shape of a loop that is not working.
    changed: z.boolean().describe("Whether anything on disk moved. Three unchanged rounds in a row is the shape of a loop that is not working."),
    // The provider session this iteration ran on, the door from a history row to a readable transcript.
    sessionId: z.string().optional().describe("The session it ran on, and the way from a history row to a readable record."),
});
export type LoopIteration = z.infer<typeof LoopIterationSchema>;
/* How a loop ended, and every one of these is a distinct thing to tell the user.
 *
 * `done`, the stop condition was met. The only success.
 * `exhausted`, maxIterations ran out with the goal unmet.
 * `stalled`, stallLimit consecutive iterations changed nothing. Reported apart from `exhausted` because the
 *   remedy is different: exhausted says "give it more room", stalled says "it is not making progress and more
 *   room will not help".
 * `overspent`, maxSpendUsd was reached.
 * `stopped`, the user pressed Stop.
 * `error`, the loop itself failed (not a turn inside it; see LoopIteration.outcome).
 */
export const LoopStateSchema = z.enum(["running", "done", "exhausted", "stalled", "overspent", "stopped", "error"]);
export type LoopState = z.infer<typeof LoopStateSchema>;
export const LoopRecordSchema = LoopSchema.extend({
    state: LoopStateSchema.describe(
        "How it ended, and each of these is a different thing to be told. Out of rounds says give it more room; stalled says it is not making progress and more room will not help. Overspent, stopped by a person, and the loop itself failing are all their own answers.",
    ),
    startedAt: z.number().describe("When it began, in milliseconds."),
    endedAt: z.number().optional().describe("When it ended, in milliseconds."),
    /* How many times a daemon BOOT has picked this loop back up. The record is its own journal: a loop still
     * marked `running` at boot is exactly one the daemon died under, which is the same trick turn-journal.ts
     * plays with its files and needs no second store to play it.
     *
     * Counted, not just flagged, for the reason the turn journal counts its attempts, a loop whose iteration
     * reliably kills the daemon (an OOM in a test it keeps running) would otherwise be resurrected on every
     * boot forever, and the container is recreated on every sandbox update. */
    resumed: z
        .number()
        .int()
        .min(0)
        .describe(
            "How many times the sandbox restarted under it and picked it back up. Counted rather than flagged, so a loop whose round reliably kills the sandbox is not resurrected on every boot for ever.",
        ),
    // Why the loop ended, for the states whose reason isn't in their name (`error`, and a `done` whose stop
    // check said something worth keeping).
    detail: z.string().optional().describe("Why it ended, for the endings whose reason is not in their name."),
    iterations: z
        .array(LoopIterationSchema)
        .describe("Every round, in order. Why it stopped at the fourth is the question a loop gets read for, and this is the answer."),
});
export type LoopRecord = z.infer<typeof LoopRecordSchema>;
export const LoopsListSchema = z.object({
    loops: z.array(LoopRecordSchema).describe("Every loop this workspace has run, newest first, kept after they end."),
});
export const LoopIdParamSchema = z.object({ conversationId: ConversationIdSchema.describe("Which conversation's loop.") });
/* ---- saved loops: the machinery, kept; the job, typed fresh each time ----
 *
 * A SAVED LOOP IS A LOOP WITH ITS GOAL TAKEN OUT, and that subtraction is the whole idea. Everything a loop
 * needs besides "what are we doing" is the same every time somebody sets one up, end on `pnpm test`, fresh
 * context, eight rounds, five dollars, stop after two idle ones, and every one of those was being retyped, in
 * a modal, before any work could begin. The goal is the only field that is genuinely new each time, and it is
 * the one field the user has ALREADY WRITTEN: it is sitting in the composer.
 *
 * So this holds the machinery and the composer holds the job, which makes a loop the same gesture as a
 * workflow, pick the shape, type the request, send. `WorkflowSchema` and this are deliberately siblings: both
 * are designs, both are picked from the composer, both leave the sentence to the message. What a workflow
 * spreads across sessions, a loop repeats in one.
 *
 * NO `conversationId` AND NO `isolated`, unlike the Loop this becomes. Both are facts about the agent the loop
 * is aimed at, decided at the moment of sending and unknowable when the design is written, a saved loop that
 * remembered a conversation would be a loop that could only ever be run once.
 */
export const LoopDesignSchema = z.object({
    id: entryId.describe("The design's id."),
    // What it is called on the composer badge and in the picker, so it has to survive being read at pill width.
    name: z.string().min(1).max(60).describe("What to call it. Short, because it has to be readable on a small badge."),
    // One line: what this loop is FOR. Optional, because a well-named loop has already said it.
    description: z.string().max(280).optional().describe("What it is for, in one line. Optional, because a well-named loop has already said it."),
    /* What each iteration is asked to do, when that is worth saying twice. Optional for the reason the ad-hoc
     * form made it optional: `goal` and `prompt` are different sentences, but making somebody write both before
     * anything runs doubles the cost of trying a loop at all. Absent ⇒ the iteration works towards the goal
     * however it sees fit. */
    prompt: z
        .string()
        .optional()
        .describe(
            "What each round is asked to do, when that is worth saying separately from the goal. Absent means each round works towards the goal however it sees fit.",
        ),
    context: LoopContextSchema.describe("How each round meets the last: starting clean, or carrying on."),
    output: LoopOutputSchema.describe("What it has to produce."),
    checks: z.array(LoopCheckSchema).describe("What else has to be true."),
    maxIterations: z.number().int().min(1).max(LOOP_ITERATIONS_MAX).describe("How many rounds before it gives up."),
    maxSpendUsd: z.number().positive().optional().describe("A ceiling on what it may spend, in dollars."),
    stallLimit: z.number().int().min(1).describe("Stop after this many rounds in a row that changed nothing."),
});
export type LoopDesign = z.infer<typeof LoopDesignSchema>;
export const LoopDesignsListSchema = z.object({
    designs: z
        .array(LoopDesignSchema)
        .describe("Saved loops: the machinery with the goal left out, so one design can be pointed at a different job every time."),
});
// Create and update on one route with the intent spelled out, exactly as a workflow saves, so an id collision
// cannot silently turn "new loop" into "replace the one you had".
export const LoopDesignSaveSchema = z.object({
    design: LoopDesignSchema.describe("The design to write."),
    create: z
        .boolean()
        .describe(
            "Whether you mean to make a new one or replace an existing one, so an id that happens to collide cannot silently overwrite the one you had.",
        ),
});
export const LoopDesignIdParamSchema = z.object({ id: entryId.describe("Which saved loop.") });
/* The design, aimed at an agent, the one conversion in the feature, kept here so the composer and anything
 * else that starts a saved loop cannot disagree about what a saved loop MEANS. The goal is the message the user
 * typed; `isolated` is a fact about the agent it is aimed at. */
export const loopFromDesign = (design: LoopDesign, aim: { conversationId: string; goal: string; isolated: boolean }): Loop => ({
    conversationId: aim.conversationId,
    goal: aim.goal,
    prompt: design.prompt ?? "Work towards the goal above. Do the next most useful thing.",
    context: design.context,
    output: design.output,
    checks: design.checks,
    maxIterations: design.maxIterations,
    ...(design.maxSpendUsd === undefined ? {} : { maxSpendUsd: design.maxSpendUsd }),
    stallLimit: design.stallLimit,
    isolated: aim.isolated,
});
/* HOW A SAVED LOOP ENDS, IN ONE LINE, the sentence under its name in the picker and on its card, computed
 * rather than stored so the two can never describe the same loop differently. Ordered as it is read: the bar it
 * has to clear first, then how far it may go trying. */
export const loopDesignLine = (design: LoopDesign): string => {
    const command = design.checks.find((check) => check.kind === "command");
    const ends =
        command !== undefined
            ? command.command
            : design.checks.some((check) => check.kind === "judge")
              ? "a reviewer agrees"
              : design.output.kind === "none"
                ? "nothing checks it"
                : "the agent says so";
    const ceilings = [`${design.maxIterations} rounds`, design.maxSpendUsd === undefined ? `` : `$${design.maxSpendUsd}`].filter(
        (part) => part !== ``,
    );
    return [ends, ...ceilings].join(" · ");
};
