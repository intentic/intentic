// workflows: a designed graph of sessions
import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema, RepoBaseSchema } from "./agent.js";
import { entryId } from "./internal.js";
import { LoopCheckSchema, LoopContextSchema, LoopDocumentSchema, LoopOutputSchema, LoopStateSchema } from "./loops.js";
// A workflow runs steps in order, each one's output feeding the next, unlike an automation's schedule or a loop's
// until-done. Each step is a Loop with a declared output in a dependency graph, so it inherits the fleet card, worktree
// and ledger. Output is validated between steps; a failing step stops the branch below it.

// Slug spliced into `wf-<run>-<step>` (branch/dir name); regex guards injection, length keeps the id under 64.
const StepIdSchema = z
    .string()
    .min(1)
    .max(24)
    .regex(/^[a-z0-9][a-z0-9-]*$/);
// How a step meets its predecessor: fresh opens a new conversation, knowing only the predecessor's declared output;
// continue carries the same conversation forward, and requires exactly one predecessor.
export const WorkflowHandoffSchema = z.enum(["fresh", "continue"]);
export type WorkflowHandoff = z.infer<typeof WorkflowHandoffSchema>;
// Enough for a real pipeline; more than this reads as two workflows, not one graph.
const WORKFLOW_STEPS_MAX = 24;
export const WorkflowStepSchema = z.object({
    id: StepIdSchema.describe("This step's own name, which other steps use to say they wait on it."),
    // What the node shows on the graph; keep it short, detail belongs in the prompt.
    title: z.string().min(1).max(60).describe("What to call it on screen. Short: the instruction below is where the detail goes."),
    // Absent means the step is judged against the run's own request; set only when its bar differs from that.
    goal: z
        .string()
        .min(1)
        .optional()
        .describe(
            "What done means for this step, in your words. It is what the step is judged against, and a different sentence from what it is told to do.",
        ),
    // Absent hands the run's own request over verbatim; declare a prompt only when the step has a job of its own.
    prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
            "What the step is told to do. The goal is the suite is green; this is run the tests, take the top failure, fix it. Leaving it out hands over the run's own request untouched, which is right for a step whose whole job is do what was asked.",
        ),
    // Steps that must finish first; empty means a root. Must be acyclic with every id existing, checked on save.
    needs: z
        .array(StepIdSchema)
        .describe(
            "Which steps must finish first. Empty means it starts when the run does. Naming a step that does not exist, or a loop between steps, is refused when the workflow is saved.",
        ),
    handoff: WorkflowHandoffSchema.describe(
        "How it meets what came before: a fresh conversation handed the previous step's result, or the same conversation carried on.",
    ),
    output: LoopOutputSchema.describe("What it has to produce for the step to count."),
    checks: z.array(LoopCheckSchema).describe("What has to pass before it counts as done."),
    // How the step's own iterations meet each other: a long step wants fresh each round, a short one continue.
    context: LoopContextSchema.describe(
        "How the step's own repeats meet each other. A long-running step wants to start clean each round; a short polish-this step wants to carry on.",
    ),
    // Unrecoverable after an unattended fan-out, unlike iteration or stall limits; absent means uncapped.
    maxSpendUsd: z
        .number()
        .positive()
        .optional()
        .describe(
            "A ceiling on what this step may spend. The one resource that cannot be recovered after an unattended fan-out, which is why it is here and iteration limits are not. Absent is uncapped.",
        ),
    agent: AgentProviderSchema.optional().describe("Which provider runs it."),
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it."),
    account: z.string().optional().describe("Which account pays for it."),
    model: z.string().optional().describe("Which model runs it."),
    // Unpinned, a step defaults to every tool and no signed-in accounts; pinning grants a scope or an account.
    actsAs: entryId
        .optional()
        .describe(
            "Which persona it acts as. Unpinned, a step gets the strict unwatched default: every tool, and no signed-in accounts at all. Pinning one is how a release check gets a voice, a folder to work in, or the single account it may post from.",
        ),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
// A gate is a promise about a run's result, separate from the design itself. It reads one named field off one step's
// declared output, the one part of an answer that was validated rather than parsed from prose.
export const WorkflowGateSchema = z.object({
    // Which step's declared output carries the decision; usually a leaf that weighs up the ones before it.
    step: StepIdSchema.describe(
        "Which step's answer carries the decision. Usually a last step that weighs up the ones before it, though nothing requires that.",
    ),
    // Which of that step's declared fields is read; checked against what it actually declares when saved.
    field: z
        .string()
        .min(1)
        .describe(
            "Which of that step's declared answers to read. A declared field is the one part of a step's answer that was checked rather than fished out of prose, which is the whole rule here. Checked when the workflow is saved.",
        ),
    // Values meaning ship it; everything else fails. An allowlist, since a hedge like mostly-pass must not ship.
    pass: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "Which values mean ship it. Everything else fails. A list of what passes rather than what fails, because a step answering mostly-pass or pass-with-notes must not ship, and this gets that right without anybody having had to enumerate the ways a model can hedge.",
        ),
    // Token isn't here: minted on save into the secrets store, carried separately as gateToken.
    // Runs per UTC day, across every caller; absent defaults to GATE_DAILY_MAX_DEFAULT, not uncapped.
    dailyMax: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "How many runs a day, across every caller. A gate is a paid door with nobody in the loop: one wired into a push-triggered pipeline is a fan-out of conversations per commit. Absent is a small default rather than unlimited.",
        ),
});
export type WorkflowGate = z.infer<typeof WorkflowGateSchema>;
// Small next to the Front Desk's 200: a gate run is a whole graph of sessions, not one turn.
export const GATE_DAILY_MAX_DEFAULT = 20;
// blocked means the gate couldn't reach a judgment, not that the product is broken; conflating the two makes teams turn
// the gate off. Maps to a neutral pipeline exit, never a failed build.
export const GateOutcomeSchema = z.enum(["pass", "fail", "blocked"]);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;
// value is the field as the step wrote it; absent means most blocked verdicts had nothing to read.
export const GateVerdictSchema = z.object({
    outcome: GateOutcomeSchema.describe(
        "Ship it, do not, or we could not tell. That third answer exists because could not reach a judgement is not the product is broken: a gate that reported its own outages as failures is one a team switches off, so it should be the honest answer far more often than the convenient one, and it means a neutral build rather than a red one.",
    ),
    // Why, in one line; realistically the only part of this a pipeline log will show.
    reason: z.string().describe("Why, in one line. Realistically the only part of this a build log will ever show."),
    runId: z.string().describe("The run behind the verdict, so somebody can go and read it."),
    value: z
        .string()
        .optional()
        .describe("What the step actually answered. Absent when there was nothing to read, which is most of the could-not-tell cases."),
});
export type GateVerdict = z.infer<typeof GateVerdictSchema>;
export const WorkflowSchema = z.object({
    id: entryId.describe("The workflow's id."),
    name: z.string().min(1).max(80).describe("What to call it."),
    description: z.string().max(400).optional().describe("What it is for."),
    steps: z
        .array(WorkflowStepSchema)
        .min(1)
        .max(WORKFLOW_STEPS_MAX)
        .describe(
            "The steps, each with what it waits on. Every one runs in its own private copy of the repos, always, because parallel steps sharing a tree collide.",
        ),
    // Present means a machine can run this for a ship decision; absent means an ordinary person-started workflow.
    gate: WorkflowGateSchema.optional().describe(
        "Present means a machine can run this design and get a ship-it answer back. Absent means an ordinary workflow, started by a person, with no outside door onto it at all.",
    ),
    // Every step runs in its own worktree, always, with no toggle; a shared tree lets a fresh step see a predecessor's
    // half-finished edits, and breaks fan-in diffs.
    // Bounded: a fan-out of N is N provider sessions, N worktrees and N times the burn rate, on one machine.
    maxParallel: z
        .number()
        .int()
        .min(1)
        .max(8)
        .describe(
            "How many steps may run at once. Bounded, because a fan-out of twelve is twelve model sessions, twelve working copies and twelve times the burn rate, on one machine.",
        ),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// skipped means the step never ran because something it waited on didn't finish; that's why a failed run shows one red
// node and a trail of grey ones.
export const WorkflowStepStateSchema = z.enum(["pending", "running", "done", "failed", "skipped", "stopped"]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;
export const WorkflowStepRunSchema = z.object({
    stepId: StepIdSchema.describe("Which step this is."),
    state: WorkflowStepStateSchema.describe(
        "How it went. Skipped carries what the others cannot: it never ran, because something it was waiting on did not finish. That is why a failed run shows one red step and a trail of grey ones.",
    ),
    // The conversation this step ran on; shared with its predecessor under continue, making them one card.
    conversationId: z
        .string()
        .describe(
            "The conversation it ran on, and the way from a node on the graph to a real record. Shared with the step before it when they were chained, which is what makes those two one card.",
        ),
    startedAt: z.number().optional().describe("When it began, in milliseconds."),
    endedAt: z.number().optional().describe("When it ended, in milliseconds."),
    iterations: z.number().int().min(0).describe("How many rounds it took."),
    costUsd: z.number().optional().describe("What it cost, in dollars."),
    // exhausted and stalled both surface as failed; the difference is whether more room would have helped.
    loopState: LoopStateSchema.optional().describe(
        "How its repeating ended. Out of rounds and stuck both come out as a failed step, and the difference between them is the difference between give it more room and more room will not help.",
    ),
    detail: z.string().optional().describe("What went wrong, when something did."),
    // Present once the step writes a document matching its declared shape; what downstream steps are handed.
    document: LoopDocumentSchema.optional().describe(
        "What it produced, once it has produced something that passes its own declared shape. This is what the steps after it are handed.",
    ),
    // Bounded preview of the closing words; the full text lives at reportPath, keeping the ledger small.
    report: z
        .string()
        .optional()
        .describe(
            "The start of its closing words. Bounded, so a long answer is not silently cut down to its last few thousand characters and the record stays a sensible size.",
        ),
    // Workspace-relative path on the shared .intentic mount; steps read it without copying into a prompt.
    reportPath: z
        .string()
        .optional()
        .describe(
            "Where the whole answer is, as a workspace path. Every step can read it, so a long handoff need not be copied into anybody's prompt.",
        ),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;
// done means every step that ran finished; any run with a skipped step counts as failed.
export const WorkflowRunStateSchema = z.enum(["running", "done", "failed", "stopped", "overspent", "error"]);
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;
export const WorkflowRunSchema = z.object({
    runId: z.string().min(1).describe("This run's id."),
    // Snapshot at run start, not a live reference; the run stays readable even if the design is edited or deleted.
    workflow: WorkflowSchema.describe(
        "The design as it stood when the run started, copied rather than looked up. The run has to keep showing the graph it actually ran, not the one edited twice since, and a run of a deleted workflow has to stay readable.",
    ),
    // One immutable commit per repo at run start; every step branches from these exact commits regardless of main.
    repos: z
        .array(RepoBaseSchema)
        .min(1)
        .max(50)
        .describe(
            "The workspace as this run began, one exact commit per repository. Every step branches from these, even if the shared tree moves while a wide fan-out is still opening its copies, so the steps can be compared with each other afterwards.",
        ),
    // What the run was asked to do, handed to every step atop its own prompt; absent when there is no composer.
    request: z
        .string()
        .optional()
        .describe(
            "What this run was asked to do, handed to every step on top of its own instructions. It is what makes one saved design worth keeping: two models, one task is a shape, and the task is different every time. Absent for a run started with nowhere to type one.",
        ),
    state: WorkflowRunStateSchema.describe(
        "How the run is going. Finished means every step that ran got there; a run with skipped steps counts as failed, because a graph that never reached its end did not do what it was asked whatever the survivors managed.",
    ),
    startedAt: z.number().describe("When it began, in milliseconds."),
    endedAt: z.number().optional().describe("When it ended, in milliseconds."),
    // How many times the sandbox restarted and picked this run back up.
    resumed: z.number().int().min(0).describe("How many times the sandbox restarted under it and picked it back up."),
    detail: z.string().optional().describe("What went wrong, when something did."),
    // One entry per step, in the design's order; all start pending so the graph is complete from the first frame.
    steps: z
        .array(WorkflowStepRunSchema)
        .describe(
            "One entry per step, in the design's own order. Every one is written down as waiting when the run starts, so the picture is complete from the first frame and a missing step never has to mean two things.",
        ),
    // Off the board like an agent's archivedAt; a run and its steps archive and unarchive as one unit.
    archivedAt: z
        .number()
        .optional()
        .describe(
            "When it was put away, in milliseconds. The record stays readable and every step's branch, transcript and counters are untouched. Its conversations are put away with it, and brought back with it. Absent means live on the board.",
        ),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
// The gate's credential; attached for a maintainer or the owner, and for nobody else.
const gateToken = z
    .string()
    .optional()
    .describe("What a pipeline presents at /workflows/{id}/gate, when the design declares a gate. Shown to a maintainer or the owner only.");
// Save answers with the stored design plus the gate credential, the only way the designer learns the pipeline URL.
export const WorkflowSavedSchema = WorkflowSchema.extend({ gateToken });
export type WorkflowSaved = z.infer<typeof WorkflowSavedSchema>;
export const WorkflowSummarySchema = WorkflowSchema.extend({ runs: z.array(WorkflowRunSchema).describe("Its runs, newest first."), gateToken });
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export const WorkflowsListSchema = z.object({ workflows: z.array(WorkflowSummarySchema).describe("Every saved design with its own run history.") });
export const WorkflowRunsListSchema = z.object({
    runs: z.array(WorkflowRunSchema).describe("Every run across every workflow, newest first, including runs of workflows since deleted."),
});
export const WorkflowIdParamSchema = z.object({ id: z.string().describe("Which workflow.") });
export const WorkflowRunIdParamSchema = z.object({ runId: z.string().describe("Which run.") });
// request is optional: a workflows-page run has no composer to fill it from, and a design whose steps already say what
// they want needs nothing more.
export const WorkflowRunStartSchema = WorkflowIdParamSchema.extend({
    request: z
        .string()
        .min(1)
        .max(20_000)
        .optional()
        .describe(
            "What to point it at. Optional, because a design whose steps already say what they want is complete on its own; only one written as a shape needs today's sentence.",
        ),
});
// Create and replace are explicit and distinct: an id collision on create conflicts, and updating a missing id never
// implicitly creates one. The daemon enforces this, not a browser convention.
export const WorkflowSaveSchema = z.object({
    workflow: WorkflowSchema.describe("The design to write."),
    create: z
        .boolean()
        .describe(
            "Whether you mean to make a new one or replace an existing one. Said outright rather than inferred, so an id that happens to collide is a refusal instead of one saved design quietly overwriting another.",
        ),
});
