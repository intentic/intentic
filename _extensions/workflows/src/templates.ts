import type { IconName } from "@intentic/extension-ui";
import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";

/* "START FROM" — the ready-made workflow, the same idea as the automations recipes and for the same reason:
 * this is a feature nobody designs well on a blank canvas, because the interesting decisions (where to break
 * the session, what each step must produce, what checks the work) are not obvious until you have seen one.
 *
 * PURE PREFILL. The daemon knows nothing about templates; picking one opens the designer with a real workflow
 * in it, which you then edit and save. Never "create it silently and hope" — a workflow costs money to run and
 * the whole point of the designer is that you look at the graph before you press go.
 *
 * ONE TEMPLATE, because there is one thing a workflow does that nothing else in the product can. A chain, a
 * convergence loop, a checklist — you can get all of those by talking to a single agent for long enough. What
 * you cannot get that way is two DIFFERENT models building the same brief at the same time in separate
 * worktrees, a third model scoring both without provider labels, and a fresh synthesis session writing the
 * version worth keeping. By hand that is four chats, two branches, and evidence held across four transcripts.
 *
 * AND IT TEACHES THE WHOLE SYNTHESIS SHAPE: identical fan-out, blind structured evaluation, and a pinned final
 * worker whose self-claim is checked by a separate model call. templates.test.ts holds those boundaries.
 */

export interface WorkflowTemplate {
    readonly icon: IconName;
    // The one-line pitch on the gallery card, and the thing that has to make the SHAPE legible: a user picks
    // from here by recognizing the shape of their own problem.
    readonly summary: string;
    readonly workflow: Workflow;
}

/* What a step is when it says nothing else. Short, because a step is mostly prose now: there are no ceilings to
 * declare, no worktree to opt into, and nothing to budget — a step runs the way any agent session runs.
 *
 * `goal` and `prompt` are NOT required here any more, and their absence is a design rather than an omission: a
 * step that declares neither is handed what the person typed, verbatim and unwrapped (WorkflowStepSchema). Most
 * steps of most shapes want exactly that. */
const step = (id: string, title: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id,
    title,
    needs: [],
    handoff: `fresh`,
    // `none`, not `claim`. A `claim` is not a free "tell me what you did" — it is a completion gate that fails
    // the step unless it writes a verdict file, and it pulls the whole output contract into the prompt. A step
    // is finished when its turn is finished, and that is what this now says.
    output: { kind: `none` },
    checks: [],
    context: `fresh`,
    ...over,
});

/* THE ATTEMPTS USED TO DECLARE FOUR REQUIRED FIELDS — approach, files, tradeoffs, risk — and both the fields
 * and the check below them are gone. They were sold as the comparison's evidence and were, in fact, its two
 * most expensive failure modes.
 *
 * A DECLARED OUTPUT IS A COMPLETION GATE, not a report. The step is not finished until it writes a valid
 * `iteration-N.json`, so an attempt that built the thing correctly and then failed to describe it in the right
 * shape is a FAILED step — and everything downstream of it is skipped. It also drags the whole output contract
 * into the prompt, which is the page of scaffolding that used to sit on top of the request.
 *
 * AND NOTHING READ THEM. The merge step is told to read the diffs — "the diffs, not the summaries of them" —
 * and it is handed both branch names to do it with. Four fields of prose about a change, written by the session
 * that made it, is the summary the merge is explicitly instructed not to trust.
 *
 * The comparison did not need them and the run is cheaper, shorter and more likely to finish without them. A
 * user who wants structured hand-off can still add it in the designer; it is no longer what you get by default.
 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
    {
        icon: `clone`,
        summary: `Claude and GPT build the same request on separate branches. A third model scores anonymous diffs, then synthesises the stronger result under an independent completion check.`,
        workflow: {
            id: `two-models-one-task`,
            name: `Two models, one task`,
            description: `One request, built twice at once by different models in their own worktrees, then read side by side and merged into the version worth keeping.`,
            // Two, which is the width of the fan-out AND the width of the run's first moment: both attempts
            // start at once, so a 1 here would silently make this a race with a false start.
            maxParallel: 2,
            steps: [
                /* THE TWO ATTEMPTS, AND THEY ARE WHERE THE RUN STARTS. Your request reaches both of them
                 * directly, at the same moment, as the first thing either session is told — which is what makes
                 * this feel like starting one agent rather than commissioning a project. It used to open with a
                 * step that turned the request into a brief for them, and that was a preamble sold as rigour:
                 * it spent a session and a minute before any code was written, and it inserted one model's
                 * reading of the task between you and both attempts, which is precisely the variable this
                 * design exists to hold still.
                 *
                 * NEITHER DECLARES A GOAL OR A PROMPT, and that is the second half of the same argument. What
                 * they used to declare was a paraphrase of "build what was asked" wrapped in five headings
                 * about the workflow — one model's reading of the task, re-inserted one layer down after being
                 * evicted from the step above. A step with neither is handed YOUR sentence, unwrapped, and is
                 * measured against it (workflow-brief.ts). The operational facts that prose used to carry — a
                 * an isolated branch of your own whose commits the daemon records — are enforced by the
                 * scheduler, so no design has to spend prompt space restating them.
                 *
                 * Same words, same output contract, different model, and neither is told the other exists — a
                 * session that knows it is being raced writes for the judge, and what you wanted to measure was
                 * how it writes code. Each gets its own worktree from the same immutable, per-repository run
                 * snapshot and its own branches, which is what the comparison below actually reads.
                 *
                 * THE MODEL IS PINNED HERE AND IS THE ONLY DIFFERENCE BETWEEN THEM. Change either one in the
                 * designer (Advanced ▸ Runs on) — Grok against Claude, or the same provider twice on two
                 * different models — and the rest of the graph runs unchanged. The model VERSION is left unset
                 * on purpose: each provider's own default is the one your subscription actually serves, and a
                 * pinned id here would go stale and refuse to run.
                 */
                // Neutral titles are part of the evaluation boundary. The provider pins remain visible to the
                // owner on the graph, but downstream prompts see only Attempt A/B and anonymous branch ids.
                step(`attempt-a`, `Attempt A`, { agent: `claude` }),
                step(`attempt-b`, `Attempt B`, { agent: `codex` }),
                step(`evaluate`, `Score both attempts`, {
                    needs: [`attempt-a`, `attempt-b`],
                    agent: `grok`,
                    goal: `Both anonymous attempts have been scored against the request, the repository, and concrete verification evidence.`,
                    prompt:
                        `Independently evaluate Attempt A and Attempt B. Read every repository diff using the exact base and branch commands above. ` +
                        `Do not infer or discuss which provider wrote either attempt; labels and authorship are irrelevant. Inspect the surrounding code ` +
                        `where a diff alone is ambiguous. Score each attempt for correctness, completeness, fit with the existing architecture, verification, ` +
                        `and regression risk. Prefer neither if both miss the request. Do not change files: produce the structured evaluation only.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `preferred`,
                                type: `string`,
                                description: `attempt-a | attempt-b | neither — the strongest starting point after inspecting both diffs`,
                                required: true,
                            },
                            {
                                name: `attempt_a_score`,
                                type: `number`,
                                description: `0 to 100 score for Attempt A against the request and repository evidence`,
                                required: true,
                            },
                            {
                                name: `attempt_b_score`,
                                type: `number`,
                                description: `0 to 100 score for Attempt B against the request and repository evidence`,
                                required: true,
                            },
                            {
                                name: `strengths`,
                                type: `string[]`,
                                description: `specific strengths worth preserving, each prefixed with A or B`,
                                required: true,
                            },
                            {
                                name: `risks`,
                                type: `string[]`,
                                description: `specific defects, omissions, or regression risks, each prefixed with A or B`,
                                required: true,
                            },
                            {
                                name: `synthesis_requirements`,
                                type: `string[]`,
                                description: `concrete requirements the final synthesis must satisfy, including verification still needed`,
                                required: true,
                            },
                        ],
                    },
                }),
                /* THE SYNTHESIS is fresh, pinned to the third provider, and sees both anonymous candidates plus
                 * an independent structured score. Its claim cannot end the step alone: a tool-less judge checks
                 * that the report names concrete verification and satisfies the score's requirements. A fixed
                 * shell command would guess a stranger's build system, so repository-specific verification is
                 * discovered by the worker and must be evidenced to the judge instead. */
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`, `evaluate`],
                    agent: `grok`,
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the project's own tests pass.`,
                    prompt:
                        `Two sessions were given the request above and each built it, on the branches named above. Read both diffs in ` +
                        `full — the diffs, not the summaries of them — and judge them against what was asked and against the code they ` +
                        `had to live in, not against your own taste in style.\n\n` +
                        `Then write the version worth keeping, here in your own worktree. Start from the stronger of the two rather ` +
                        `than retyping it: in every repository where it changed files, bring its named branch in with \`git merge --squash\`, ` +
                        `then fix what it got wrong and fold in ` +
                        `whatever the other one did better. Treat the independent score above as evidence, not authority: verify every recommendation against ` +
                        `the code. Run whatever this project uses to test itself and leave it passing. ` +
                        `What lands must read as one change somebody made on purpose, not as two ` +
                        `stitched together — and say, in a sentence each, what you took from where.`,
                    output: { kind: `claim` },
                    checks: [
                        {
                            kind: `judge`,
                            rubric:
                                `The report identifies the chosen starting point, what was incorporated from the other attempt, the exact verification ` +
                                `commands and their outcomes, and shows that every synthesis requirement and the original request are satisfied now. ` +
                                `Unrun, failing, or vaguely described verification means CONTINUE.`,
                        },
                    ],
                }),
            ],
        },
    },
];
