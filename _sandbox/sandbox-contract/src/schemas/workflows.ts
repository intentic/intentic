// workflows: a designed graph of sessions
import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema, RepoBaseSchema } from "./agent.js";
import { entryId } from "./internal.js";
import { LoopCheckSchema, LoopContextSchema, LoopDocumentSchema, LoopOutputSchema, LoopStateSchema } from "./loops.js";
/* THE THIRD DRIVER. An automation answers "run this at 3am", a loop answers "run this until it is done", and a
 * workflow answers "run these, in this order, each handing its result to the next".
 *
 * IT IS A GRAPH OF LOOPS, and that is the whole implementation. A step is not a new kind of execution, it is
 * a Loop with a declared output and a place in a dependency graph, driven on a conversation of its own. So
 * every step gets the fleet card, the worktree, the transcript, the cost ledger, the Stop button, the stall
 * detector and the spend ceiling without a line of new code, and this file's job is only to say what the steps
 * are and what depends on what.
 *
 * WHY IT IS NOT "AN AUTOMATION WITH SEVERAL PROMPTS". Because the value is in the SEAM between steps: the
 * output of one is validated before the next is allowed to start, the reviewing step is a different session
 * from the implementing one, and a step that cannot converge stops the branch below it rather than feeding
 * garbage forward. None of that exists in a prompt that says "then do X".
 */

// A step id: short and slug-shaped because it is spliced into the derived conversation id (`wf-<run>-<step>`),
// which is itself a branch name and a directory name. The regex is the injection guard, the length cap is what
// keeps the derived id inside ConversationIdSchema's 64.
const StepIdSchema = z
    .string()
    .min(1)
    .max(24)
    .regex(/^[a-z0-9][a-z0-9-]*$/);
/* HOW A STEP MEETS ITS PREDECESSOR, the fork the whole feature turns on, and the one the user has to choose
 * because neither answer is right twice in a row.
 *
 * `fresh` opens a NEW conversation: its own fleet card, its own session, its own worktree when the run is
 * isolated. What it knows about the step before it is exactly what that step declared as output. This is the
 * only honest way to run a review, an audit or a second opinion, a session that spent nine turns arguing for
 * an approach is the worst available judge of whether that approach worked, and the fix is not a better prompt,
 * it is a different session.
 *
 * `continue` sends the next prompt into the SAME conversation. The model keeps everything it learned, the
 * prefix stays cached, and, when the run is isolated, the work stays in one worktree on one branch, which is
 * the only way a chain like implement → test → document can build on itself at all. Requires exactly one
 * predecessor: two upstream sessions cannot both be continued into one.
 */
export const WorkflowHandoffSchema = z.enum(["fresh", "continue"]);
export type WorkflowHandoff = z.infer<typeof WorkflowHandoffSchema>;
// Enough steps for a real pipeline, few enough that a workflow stays legible as one picture. A design past
// this is two workflows, and reading it as one graph was never going to work.
const WORKFLOW_STEPS_MAX = 24;
export const WorkflowStepSchema = z.object({
    id: StepIdSchema.describe("This step's own name, which other steps use to say they wait on it."),
    // What the node says on the graph. Short, the prompt is where the detail goes.
    title: z.string().min(1).max(60).describe("What to call it on screen. Short: the instruction below is where the detail goes."),
    /* What "done" means for this step, in the user's words. Put to the judge, and restated to the model unless
     * its instruction already carries it (loop-brief); it is the sentence the step is measured against.
     *
     * ABSENT ⇒ THE RUN'S OWN REQUEST IS THE GOAL, which is the ordinary case and not the exotic one. A saved
     * workflow is a SHAPE, "two models on one task", and for most of its steps the thing being asked for is
     * whatever the person typed this time. Writing a goal here as well means saying the same thing twice and
     * keeping the two in agreement forever; leaving it out means the step is measured against the request,
     * which is what anyone would have written anyway. Declare one only where the step's bar is genuinely its
     * own ("the suite is green") rather than the run's.
     */
    goal: z
        .string()
        .min(1)
        .optional()
        .describe(
            "What done means for this step, in your words. It is what the step is judged against, and a different sentence from what it is told to do.",
        ),
    /* What the step is told to DO. A different sentence from the goal: "the suite is green" is the goal,
     * "run the tests, take the top failure, fix it" is the instruction.
     *
     * ABSENT ⇒ THE REQUEST IS HANDED OVER VERBATIM, with none of the workflow's own framing around it (see
     * briefForStep). That is the default because the framing is not free: every heading between the reader's
     * sentence and the model is a chance for the model to answer the frame instead of the question, and a step
     * whose whole job is "do what was asked" has nothing to add to it. A step that DOES declare a prompt is
     * saying it has a job of its own, review this, merge those, and gets the full brief, request included.
     */
    prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
            "What the step is told to do. The goal is the suite is green; this is run the tests, take the top failure, fix it. Leaving it out hands over the run's own request untouched, which is right for a step whose whole job is do what was asked.",
        ),
    // The steps that must finish before this one starts. Empty ⇒ a root, started when the run starts. The
    // graph must be acyclic and every id must exist; both are checked when the workflow is saved.
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
    // How the step's own ITERATIONS meet each other, the Ralph question, one level down from `handoff`. A
    // long-running step wants `fresh` (no context rot); a short refine-this step wants `continue`.
    context: LoopContextSchema.describe(
        "How the step's own repeats meet each other. A long-running step wants to start clean each round; a short polish-this step wants to carry on.",
    ),
    /* Iteration/stall limits remain scheduler backstops rather than form questions. Spend is different: it is
     * the one resource the owner cannot recover after an unattended fan-out, and the underlying loop already
     * enforces it exactly. Absent remains uncapped for short, person-started work. */
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
    /* Which persona the step acts as, the same field a chat turn and an automation carry (AgentTurnSchema.
     * actsAs), because a step IS an unattended turn under the loop machinery. Unpinned, a step keeps the
     * strict unattended default: full tools, no logged-in accounts. Pinning a card is how a gated release
     * check gets a voice, a folder scope, or the one Reddit it is allowed to post from, a decision the owner
     * already wrote down once, on the card. */
    actsAs: entryId
        .optional()
        .describe(
            "Which persona it acts as. Unpinned, a step gets the strict unwatched default: every tool, and no signed-in accounts at all. Pinning one is how a release check gets a voice, a folder to work in, or the single account it may post from.",
        ),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
/* THE GATE, how a finished run becomes a release decision, and how a machine with no identity asks for one.
 *
 * A workflow is a DESIGN; a gate is a PROMISE ABOUT ITS RESULT, and keeping the two separable is the whole
 * point. What a run does, how many sessions, whether they drive a browser, which repos they touch, stays the
 * graph's business, because the value of running a release check this way is that the check is a workflow like
 * any other: an acceptance sweep today, a security review or a performance budget next month, with nothing
 * here ever learning what any of them are.
 *
 * So a gate reads exactly one thing: a named FIELD off a named STEP's declared output (output-fields.ts). That
 * field already exists for precisely the reason this needs it, a declared field is the one part of a session's
 * answer that was VALIDATED rather than parsed back out of the prose the model was talking to a person in,
 * and pointing at one is the entire rule.
 */
export const WorkflowGateSchema = z.object({
    // Which step's declared output carries the decision. Ordinarily a leaf that weighs up the steps before it;
    // nothing requires that, and a one-step workflow naming its only step is the common small case.
    step: StepIdSchema.describe(
        "Which step's answer carries the decision. Usually a last step that weighs up the ones before it, though nothing requires that.",
    ),
    // Which of that step's declared fields is read. Checked against what the step actually declares when the
    // workflow is saved, a gate pointed at a field nobody writes answers `blocked` on every run, forever.
    field: z
        .string()
        .min(1)
        .describe(
            "Which of that step's declared answers to read. A declared field is the one part of a step's answer that was checked rather than fished out of prose, which is the whole rule here. Checked when the workflow is saved.",
        ),
    /* The values of that field that mean SHIP IT. Everything else fails the gate.
     *
     * An allowlist rather than a blocklist, because the two are not symmetric under a model's vocabulary. A
     * step that answers "mostly-pass", "pass-with-notes" or "pass (2 minor defects)" must not ship, and the
     * allowlist gets that right without anyone having had to enumerate the ways a model can hedge.
     */
    pass: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "Which values mean ship it. Everything else fails. A list of what passes rather than what fails, because a step answering mostly-pass or pass-with-notes must not ship, and this gets that right without anybody having had to enumerate the ways a model can hedge.",
        ),
    // The webhook's own auth, minted on save exactly as an event automation's is. The caller is a pipeline
    // runner with no Google identity, so this is the only credential in the exchange.
    token: z
        .string()
        .optional()
        .describe(
            "The credential the calling pipeline presents. It is the only one in the exchange, because a build runner has no identity of its own here.",
        ),
    /* Runs per UTC day, across every caller. A gate is a paid endpoint reachable with no person in the loop:
     * one of these wired into a push-triggered pipeline is a fan-out of sessions per commit, and the
     * per-request deadline bounds one call's WALL CLOCK without bounding the day's SPEND. Absent ⇒
     * GATE_DAILY_MAX_DEFAULT, not uncapped, for the reason the Front Desk's ceiling is not optional either.
     */
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
/* The gate's daily ceiling when its author sets none. Deliberately small next to the Front Desk's 200: a
 * Front Desk message is one turn, a gate run is a whole graph of sessions, and the honest comparison is cost
 * rather than count. Twenty is a busy day of merges and a script's first minute. */
export const GATE_DAILY_MAX_DEFAULT = 20;
/* What a gate answers a pipeline, and the three-way split matters.
 *
 * `blocked` exists for the same reason acceptance's verdict has one: "we could not reach a judgment" is not
 * "the product is broken". A gate that reported them the same way would go red for its own outages, and a team
 * that cannot tell the two apart turns the gate off, so `blocked` is meant to be the honest answer far more
 * often than it is the convenient one. It maps to a NEUTRAL pipeline exit, never a failed build.
 */
export const GateOutcomeSchema = z.enum(["pass", "fail", "blocked"]);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;
// What the gate route answers with. `value` is the field as the step actually wrote it, absent when the gate
// never got one to read, which is every `blocked` that is not a disagreement about the value.
export const GateVerdictSchema = z.object({
    outcome: GateOutcomeSchema.describe(
        "Ship it, do not, or we could not tell. That third answer exists because could not reach a judgement is not the product is broken: a gate that reported its own outages as failures is one a team switches off, so it should be the honest answer far more often than the convenient one, and it means a neutral build rather than a red one.",
    ),
    // One line: why. Realistically the only part of this a pipeline log will ever show.
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
    // Present ⇒ this design can be run by a machine and answers a release decision. Absent ⇒ an ordinary
    // workflow, started by a person from the workflows page, with no public door onto it at all.
    gate: WorkflowGateSchema.optional().describe(
        "Present means a machine can run this design and get a ship-it answer back. Absent means an ordinary workflow, started by a person, with no outside door onto it at all.",
    ),
    /* EVERY STEP RUNS IN ITS OWN WORKTREE, always, with no toggle, the same thing an isolated agent session
     * does, which is what every session in this product already is.
     *
     * It was a per-workflow choice between worktrees and the shared /work tree, and the shared side never
     * earned its place: parallel steps on one tree collide, a `fresh` step there sees a half-finished
     * predecessor's edits as if they were the workspace, and the pinned-base-to-branch comparisons that make
     * a fan-in READABLE (see workflow-brief) only exist on the isolated side. A setting whose other value is a
     * subtle trap is not a setting, it is a mistake waiting for somebody to make it.
     */
    // How many steps may run at once. Bounded because a fan-out of twelve is twelve provider sessions, twelve
    // worktrees and twelve times the burn rate, and because the machine this runs on is one machine.
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
// The rules a graph has to clear before it can be saved or run, the acyclic `needs`, the once-only
// continuation, are in workflow-faults.ts, because they are about the graph rather than about any field here.

/* How one step ended. `skipped` is the one that carries information the others cannot: it means the step never
 * ran because something it waited for did not finish, which is why a failed workflow shows one red node and a
 * trail of grey ones rather than a wall of failures that all say the same thing.
 */
export const WorkflowStepStateSchema = z.enum(["pending", "running", "done", "failed", "skipped", "stopped"]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;
export const WorkflowStepRunSchema = z.object({
    stepId: StepIdSchema.describe("Which step this is."),
    state: WorkflowStepStateSchema.describe(
        "How it went. Skipped carries what the others cannot: it never ran, because something it was waiting on did not finish. That is why a failed run shows one red step and a trail of grey ones.",
    ),
    // The conversation this step ran on, derived, and the door from a node on the graph to a real transcript.
    // Shared with the predecessor when the handoff is `continue`, which is what makes those steps one card.
    conversationId: z
        .string()
        .describe(
            "The conversation it ran on, and the way from a node on the graph to a real record. Shared with the step before it when they were chained, which is what makes those two one card.",
        ),
    startedAt: z.number().optional().describe("When it began, in milliseconds."),
    endedAt: z.number().optional().describe("When it ended, in milliseconds."),
    iterations: z.number().int().min(0).describe("How many rounds it took."),
    costUsd: z.number().optional().describe("What it cost, in dollars."),
    // How the step's LOOP ended, `exhausted` and `stalled` both land as a `failed` step, and the difference
    // between them is the difference between "give it more room" and "more room will not help".
    loopState: LoopStateSchema.optional().describe(
        "How its repeating ended. Out of rounds and stuck both come out as a failed step, and the difference between them is the difference between give it more room and more room will not help.",
    ),
    detail: z.string().optional().describe("What went wrong, when something did."),
    // What the step produced. Present once the step has written a valid document, which for a `json` output
    // means it matched the declared fields. This is what the steps downstream are given.
    document: LoopDocumentSchema.optional().describe(
        "What it produced, once it has produced something that passes its own declared shape. This is what the steps after it are handed.",
    ),
    /* A bounded preview of the step's closing words. The complete response lives at `reportPath`, so a long-form
     * handoff is not silently reduced to its last few thousand characters and the ledger stays bounded. */
    report: z
        .string()
        .optional()
        .describe(
            "The start of its closing words. Bounded, so a long answer is not silently cut down to its last few thousand characters and the record stays a sensible size.",
        ),
    // Workspace-relative shared-state artifact containing the complete response. Fresh worktrees and a resumed
    // daemon see the same .intentic mount, so downstream steps can read it without copying it into their prompt.
    reportPath: z
        .string()
        .optional()
        .describe(
            "Where the whole answer is, as a workspace path. Every step can read it, so a long handoff need not be copied into anybody's prompt.",
        ),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;
// `done` means every step that ran finished; a run with skipped steps is `failed`, because a graph that did not
// reach its leaves did not do what it was asked whatever the survivors managed.
export const WorkflowRunStateSchema = z.enum(["running", "done", "failed", "stopped", "overspent", "error"]);
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;
export const WorkflowRunSchema = z.object({
    runId: z.string().min(1).describe("This run's id."),
    /* The workflow AS IT WAS WHEN THE RUN STARTED, snapshotted rather than referenced. Three things need this
     * and none of them tolerate a live lookup: the run view draws the graph the run actually ran (not the one
     * that has been edited twice since), the boot resume needs the step definitions of a workflow that may have
     * been deleted, and a history row for a deleted workflow is otherwise an id and nothing else. */
    workflow: WorkflowSchema.describe(
        "The design as it stood when the run started, copied rather than looked up. The run has to keep showing the graph it actually ran, not the one edited twice since, and a run of a deleted workflow has to stay readable.",
    ),
    /* The workspace as this run began, one immutable commit per repository. Every fresh step branches from
     * these exact commits, even if main moves while a wide fan-out is still opening worktrees. Handoffs use the
     * same bases in their diff commands, so provenance works in nested repositories as well as at root. */
    repos: z
        .array(RepoBaseSchema)
        .min(1)
        .max(50)
        .describe(
            "The workspace as this run began, one exact commit per repository. Every step branches from these, even if the shared tree moves while a wide fan-out is still opening its copies, so the steps can be compared with each other afterwards.",
        ),
    /* WHAT THIS RUN WAS ASKED TO DO, the sentence the user typed when they started it, handed to every step
     * on top of its own prompt. Absent for a run started from the workflows page, which has no composer.
     *
     * It is what makes one saved design worth keeping: "two models, one task" is a SHAPE, and the task is
     * different every time. Without this the only way to point a workflow at today's job is to open the
     * designer and retype a step's prompt, which means the design and the request are the same document,
     * and editing a graph to ask a question is not something anybody does twice.
     *
     * Snapshotted on the run beside the workflow, and for the same reason: the run has to stay readable, and
     * "what was this one about" is the first thing anyone asks of a row in the history.
     */
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
    // How many daemon boots have picked this run back up, the same counter, and the same reason, as a loop's.
    resumed: z.number().int().min(0).describe("How many times the sandbox restarted under it and picked it back up."),
    detail: z.string().optional().describe("What went wrong, when something did."),
    // One entry per step, in the workflow's own order. Written at start with every step `pending`, so the graph
    // is complete from the first frame and a node's absence never has to mean two things.
    steps: z
        .array(WorkflowStepRunSchema)
        .describe(
            "One entry per step, in the design's own order. Every one is written down as waiting when the run starts, so the picture is complete from the first frame and a missing step never has to mean two things.",
        ),
    /* When the run was ARCHIVED (ms epoch), off the board, exactly as an agent's `archivedAt` takes a card off
     * it, and the same promise: the run record stays readable in the history and every step's branch,
     * transcript and counters are untouched. Absent ⇒ live on the board.
     *
     * A RUN AND ITS STEPS ARCHIVE AS ONE, which is the whole reason this field exists rather than the record
     * simply being dropped. A run's steps have no card of their own, the run's row is what stands for them,
     * so deleting the record was releasing five loose conversations back onto the board at the moment the user
     * said they were finished with the job. Archiving the run archives its sessions with it and unarchiving
     * brings both back, so "done with this" means the same thing for a workflow as it does for an agent. */
    archivedAt: z
        .number()
        .optional()
        .describe(
            "When it was put away, in milliseconds. The record stays readable and every step's branch, transcript and counters are untouched. Its conversations are put away with it, and brought back with it. Absent means live on the board.",
        ),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
// The list row: the stored workflow plus the runs it has had, newest first.
export const WorkflowSummarySchema = WorkflowSchema.extend({ runs: z.array(WorkflowRunSchema).describe("Its runs, newest first.") });
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export const WorkflowsListSchema = z.object({ workflows: z.array(WorkflowSummarySchema).describe("Every saved design with its own run history.") });
export const WorkflowRunsListSchema = z.object({
    runs: z.array(WorkflowRunSchema).describe("Every run across every workflow, newest first, including runs of workflows since deleted."),
});
export const WorkflowIdParamSchema = z.object({ id: z.string().describe("Which workflow.") });
export const WorkflowRunIdParamSchema = z.object({ runId: z.string().describe("Which run.") });
/* Starting a run: which design, and what to point it at. The request is optional because the workflows page
 * starts runs with no composer to read one from, a design whose steps already say what they want is complete
 * on its own, and only a design written as a shape needs today's sentence. */
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
// Creation and replacement are deliberately distinct. An id collision on create is a conflict; an update of
// a missing id is not an implicit create. That makes the daemon, rather than a browser naming convention, the
// authority that prevents one saved design from overwriting another.
export const WorkflowSaveSchema = z.object({
    workflow: WorkflowSchema.describe("The design to write."),
    create: z
        .boolean()
        .describe(
            "Whether you mean to make a new one or replace an existing one. Said outright rather than inferred, so an id that happens to collide is a refusal instead of one saved design quietly overwriting another.",
        ),
});
