// loops: run a conversation again, and again, until a goal is met
import { z } from "zod";
import { STATE_DIR } from "@intentic/constants";
import { OutputFieldsSchema } from "../policy/output-fields.js";
import { AgentHarnessSchema, AgentProviderSchema, ConversationIdSchema, RepoBaseSchema } from "./agent.js";
import { entryId } from "./internal.js";
// A loop answers "run until actually done" (converges), unlike an automation's cadence ("run at 3am", repeats forever).
// It's an attribute of an ordinary conversation, not a new object, so the worktree, ledger, transcript and Stop button
// all just work.

// How the next iteration meets its context.
// fresh (default): a new provider session on the same worktree; immune to context rot, costs a re-read each time.
// continue: resumes the session; cheaper, keeps reasoning, but degrades on long runs.
export const LoopContextSchema = z.enum(["fresh", "continue"]);
export type LoopContext = z.infer<typeof LoopContextSchema>;
// What the loop produces, asked separately from what ends it (see `checks`), since conflating them blocks chaining
// loops together.
// none: nothing but the work itself.
// claim: structured self-report, `{done, reason, evidence?}`.
// json: a declared shape, `{done, reason, data}`, usable as the next step's input.
// All three land in one file per iteration (`LoopDocumentSchema`).
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
// What else has to be true, ANDed with the output above; must be a different call from the work, or it isn't a check.
// command: a shell one-liner in the tree; exit 0 means satisfied. Deterministic.
// judge: a separate, tool-less model call rules on the iteration's own report.
export const LoopCheckSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z
            .literal("command")
            .describe(
                "Run something and see if it passes. Deterministic, free, and the only signal here whose answer does not come from a model. A passing test suite beats any amount of self-report.",
            ),
        command: z.string().min(1).describe("The command to run in the conversation's own tree. Exiting cleanly means satisfied."),
    }),
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
// The verdict file every iteration writes, one shape for all three output kinds; a file, not a reply sentence, since
// parsing structure out of prose the model is also using to talk to a person serves neither well.
export const LoopDocumentSchema = z.object({
    done: z.boolean().describe("Whether the goal is met. Reading this is the whole point of the file."),
    reason: z.string().describe("Why, in one line. The most-read sentence in the feature: the next round reads it first and the history shows it."),
    evidence: z
        .string()
        .optional()
        .describe(
            "What was checked to know that. Optional, so a round with nothing to point at says so by leaving it out rather than by inventing a sentence.",
        ),
    data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The declared answer, for a loop that asked for one, checked against the shape it declared."),
});
export type LoopDocument = z.infer<typeof LoopDocumentSchema>;
// Bounds a misconfigured loop; one that hasn't converged in 50 rounds is not one round short of it.
const LOOP_ITERATIONS_MAX = 50;
export const LoopSchema = z.object({
    // Brings its fleet card, worktree and transcript for free.
    conversationId: ConversationIdSchema.describe(
        "The conversation to loop. It need not exist yet: naming a fresh one opens it, which is what lets run this until it passes be the first thing you ever say.",
    ),
    goal: z
        .string()
        .min(1)
        .describe(
            "What done means, in your words. It goes into every round's instructions and into the judge's question, so the model is told the bar rather than left to infer it.",
        ),
    prompt: z
        .string()
        .min(1)
        .describe("What each round is asked to do. The suite passes is the goal; run the tests, take the top failure, fix it is the instruction."),
    context: LoopContextSchema.describe(
        "How each round meets the last. Starting fresh makes the files the memory rather than the conversation, so the twentieth round reads the tree as clearly as the first, and costs a re-read each time. Carrying on is cheaper and keeps the reasoning, which suits a short polish-this loop and degrades on long ones: a session that has spent eleven rounds arguing for its own approach is the worst available judge of whether that approach is finished.",
    ),
    output: LoopOutputSchema,
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
    maxSpendUsd: z
        .number()
        .positive()
        .optional()
        .describe(
            "A ceiling on what the whole loop may spend, in dollars. Optional for a short loop somebody is watching, and strongly wanted otherwise: this is the first thing here that can keep spending with nobody pressing anything between rounds.",
        ),
    stallLimit: z
        .number()
        .int()
        .min(1)
        .describe(
            "Stop after this many rounds in a row that changed nothing on disk. The guard that matters most: a loop's failure is not runaway success, it is an agent re-reading the same three files, restating the same plan and declaring more work remains, eleven times. Every one of those rounds succeeds, so only the tree not moving catches it.",
        ),
    isolated: z
        .boolean()
        .describe(
            "Whether it works in the conversation's own private copy or in the shared tree. It also decides where a check runs: testing the shared tree would be testing code this loop has not merged yet.",
        ),
    // Same three passthroughs as an automation: a headless driver has no composer to read them from. Absent falls back
    // to the conversation's last choice, then the provider default.
    agent: AgentProviderSchema.optional().describe("Which provider the rounds run on. Absent falls back to the conversation's own last choice."),
    harness: AgentHarnessSchema.optional().describe("Which agentic loop they run on."),
    account: z.string().optional().describe("Which account pays."),
    model: z.string().optional().describe("Which model."),
    actsAs: entryId
        .optional()
        .describe(
            "Which persona the rounds act as. It matters here: every round is unwatched, and an unwatched turn naming no persona reaches no signed-in account at all, so pinning one is how a loop gets hands.",
        ),
    // Also stops a later iteration from inheriting the sandbox's global auto-land posture.
    worktreeBase: z
        .array(RepoBaseSchema)
        .min(1)
        .max(50)
        .optional()
        .describe("Pin the private copy to these exact commits, so a restart cannot quietly change what the loop is working on."),
    autoLand: z.boolean().optional().describe("Whether the work merges as it goes."),
});
export type Loop = z.infer<typeof LoopSchema>;
// A loop with nothing to produce and nothing to check can only run to `exhausted`. A predicate, not a schema
// refinement, since both `start` and `saveDesign` need it at different moments.
export const loopCanConverge = (loop: Pick<Loop, "output" | "checks">): boolean => loop.output.kind !== "none" || loop.checks.length > 0;
// Shared into an isolated turn's worktree (outside every repo, no git noise). `progress.md` is the loop's memory in
// `fresh` mode, its audit trail in `continue`; `iteration-<n>.json` is the verdict a `claim` stop reads.
export const LOOP_DIR = `${STATE_DIR}/records/artifacts/loops`;
export const LoopIterationSchema = z.object({
    n: z.number().int().min(1).describe("Which round this was."),
    at: z.number().describe("When it ran, in milliseconds."),
    outcome: z
        .enum(["continue", "done", "error"])
        .describe(
            "How the round ended, which is not the same question as how the loop did. A round that errored does not end the loop by itself: a failing turn is often exactly what the next round is meant to fix.",
        ),
    detail: z
        .string()
        .optional()
        .describe("What the check said, in its own words. What a run history is actually read for: why it kept going, and why it stopped."),
    costUsd: z.number().optional().describe("What the round cost, in dollars."),
    changed: z.boolean().describe("Whether anything on disk moved. Three unchanged rounds in a row is the shape of a loop that is not working."),
    sessionId: z.string().optional().describe("The session it ran on, and the way from a history row to a readable record."),
});
export type LoopIteration = z.infer<typeof LoopIterationSchema>;
// How a loop ended:
// done: the stop condition was met.
// exhausted: maxIterations ran out, goal unmet.
// stalled: stallLimit consecutive no-op iterations — more room won't help, unlike exhausted.
// overspent: maxSpendUsd reached.
// stopped: the user pressed Stop.
// error: the loop itself failed, not a turn inside it (see `LoopIteration.outcome`).
export const LoopStateSchema = z.enum(["running", "done", "exhausted", "stalled", "overspent", "stopped", "error"]);
export type LoopState = z.infer<typeof LoopStateSchema>;
export const LoopRecordSchema = LoopSchema.extend({
    state: LoopStateSchema.describe(
        "How it ended, and each of these is a different thing to be told. Out of rounds says give it more room; stalled says it is not making progress and more room will not help. Overspent, stopped by a person, and the loop itself failing are all their own answers.",
    ),
    startedAt: z.number().describe("When it began, in milliseconds."),
    endedAt: z.number().optional().describe("When it ended, in milliseconds."),
    // The record is its own boot journal; still `running` at boot means the daemon died mid-loop.
    resumed: z
        .number()
        .int()
        .min(0)
        .describe(
            "How many times the sandbox restarted under it and picked it back up. Counted rather than flagged, so a loop whose round reliably kills the sandbox is not resurrected on every boot for ever.",
        ),
    // Mainly `error`, and a `done` whose check said something worth keeping.
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
// A saved loop is a loop with its goal removed: the machinery (checks, output, limits) is reused, the composer supplies
// the goal at send time, the same relationship `WorkflowSchema` has to a workflow. No `conversationId`/`isolated`: both
// are facts about the agent aimed at, unknowable when the design is written.
export const LoopDesignSchema = z.object({
    id: entryId.describe("The design's id."),
    name: z.string().min(1).max(60).describe("What to call it. Short, because it has to be readable on a small badge."),
    description: z.string().max(280).optional().describe("What it is for, in one line. Optional, because a well-named loop has already said it."),
    // Optional so trying a loop doesn't require writing two sentences before anything runs.
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
// One route for create and update, like a workflow save, with intent spelled out rather than inferred from an id
// collision.
export const LoopDesignSaveSchema = z.object({
    design: LoopDesignSchema.describe("The design to write."),
    create: z
        .boolean()
        .describe(
            "Whether you mean to make a new one or replace an existing one, so an id that happens to collide cannot silently overwrite the one you had.",
        ),
});
export const LoopDesignIdParamSchema = z.object({ id: entryId.describe("Which saved loop.") });
// Turns a design into a runnable loop; kept here so nothing that starts a saved loop can disagree about what one means.
// `goal` is the user's message; `isolated` is a fact about the agent aimed at.
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
// One-line summary for the picker/card, computed rather than stored so the two can't disagree; ordered as read: the bar
// first, then how far it may try.
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
