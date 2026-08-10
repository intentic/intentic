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
 * TWO CARDS, AND THE FIRST ONE IS THE FEATURE. There is one thing a workflow does that nothing else in the
 * product can: two DIFFERENT models building the same request at the same time in separate worktrees, and a
 * third session that reads both diffs and writes the version worth keeping. Three steps, no paperwork — by hand
 * it is two chats, two branches and a comparison you hold in your head from transcripts you cannot read at once.
 * That is the whole pitch and it must stay readable in one glance at the graph.
 *
 * THE SECOND CARD IS THE SAME RACE WITH THE MACHINERY TURNED ON — a blind scoring pass with a declared JSON
 * output, and a merge whose own claim is checked by an independent judge. It exists because those controls are
 * in the designer and something should demonstrate and exercise them end to end. It is deliberately NOT the
 * default: it spends a fourth session and two more model calls before anything lands, and a person clicking
 * their first workflow should not pay for a scoring rubric they have not asked for yet.
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

/* THE TWO ATTEMPTS, SHARED BY BOTH TEMPLATES, AND THEY ARE WHERE EITHER RUN STARTS. Your request reaches both
 * of them directly, at the same moment, as the first thing either session is told — which is what makes this
 * feel like starting one agent rather than commissioning a project. This used to open with a step that turned
 * the request into a brief for them, and that was a preamble sold as rigour: it spent a session and a minute
 * before any code was written, and it inserted one model's reading of the task between you and both attempts,
 * which is precisely the variable this design exists to hold still.
 *
 * NEITHER DECLARES A GOAL OR A PROMPT, and that is the second half of the same argument. What they used to
 * declare was a paraphrase of "build what was asked" wrapped in five headings about the workflow — one model's
 * reading of the task, re-inserted one layer down after being evicted from the step above. A step with neither
 * is handed YOUR sentence, unwrapped, and is measured against it (workflow-brief.ts). The operational facts
 * that prose used to carry — an isolated branch of your own whose commits the daemon records — are enforced by
 * the scheduler, so no design has to spend prompt space restating them.
 *
 * NOR DOES EITHER DECLARE AN OUTPUT OR A CHECK. A declared output is a COMPLETION GATE: the step fails unless
 * it writes a valid document, so an attempt that built the thing correctly and then described it in the wrong
 * shape is a FAILED step that takes everything downstream with it. And nothing read those fields anyway — the
 * merge is told to read the diffs, "not the summaries of them", and is handed both branch names to do it with.
 *
 * Same words, same (empty) contract, different model, and neither is told the other exists — a session that
 * knows it is being raced writes for the judge, and what you wanted to measure was how it writes code. Each
 * gets its own worktree from the same immutable, per-repository run snapshot and its own branches, which is
 * what everything downstream actually reads.
 *
 * THE MODEL IS PINNED HERE AND IS THE ONLY DIFFERENCE BETWEEN THEM. Change either one in the designer
 * (Advanced ▸ Runs on) — Grok against Claude, or the same provider twice on two different models — and the rest
 * of the graph runs unchanged. The model VERSION is left unset on purpose: each provider's own default is the
 * one your subscription actually serves, and a pinned id here would go stale and refuse to run.
 *
 * THE TITLES ARE NEUTRAL BECAUSE TITLES TRAVEL. Every downstream step is handed its predecessors under
 * `### From "<title>"`, so "Claude's attempt" would tell the session judging the diffs which family wrote which
 * — the one thing this comparison cannot afford to leak. The pins stay visible to the owner on the graph. */
const attempts = (): WorkflowStep[] => [step(`attempt-a`, `Attempt A`, { agent: `claude` }), step(`attempt-b`, `Attempt B`, { agent: `codex` })];

// How the merge reads and writes, in both templates: start from the stronger branch rather than retyping it,
// fix what it got wrong, fold in what the other did better, leave the project's own tests passing.
const SYNTHESIS_PROMPT =
    `Two sessions were given the request above and each built it, on the branches named above. Read both diffs in ` +
    `full — the diffs, not the summaries of them — and judge them against what was asked and against the code they ` +
    `had to live in, not against your own taste in style.\n\n` +
    `Then write the version worth keeping, here in your own worktree. Start from the stronger of the two rather ` +
    `than retyping it: in every repository where it changed files, bring its named branch in with \`git merge --squash\`, ` +
    `then fix what it got wrong and fold in whatever the other one did better. Run whatever this project uses to test ` +
    `itself and leave it passing. What lands must read as one change somebody made on purpose, not as two ` +
    `stitched together — and say, in a sentence each, what you took from where.`;

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
    {
        icon: `clone`,
        summary: `What you type goes to Claude and to GPT at the same moment, each building it on a branch of its own. A third session then reads both diffs, keeps what each got right, and writes the merged version.`,
        workflow: {
            id: `two-models-one-task`,
            name: `Two models, one task`,
            description: `One request, built twice at once by different models in their own worktrees, then read side by side and merged into the version worth keeping.`,
            // Two, which is the width of the fan-out AND the width of the run's first moment: both attempts
            // start at once, so a 1 here would silently make this a race with a false start.
            maxParallel: 2,
            steps: [
                ...attempts(),
                /* THE SYNTHESIS — one step, and it both reads and writes. There is no scoring pass in front of
                 * it, and that is the design rather than an omission: a separate session that reads both diffs
                 * and grades them spends a fourth model on producing an opinion this step is then told to
                 * verify against the code anyway. Reading the two diffs IS the comparison, and the session
                 * doing the merge is the one that has to be convinced.
                 *
                 * FRESH, so it wrote neither attempt and has no stake in either — the same reason a reviewer is
                 * a different session, and what makes this merge worth more than asking either author which one
                 * won. It is handed both BRANCH NAMES (the run supplies those), so `git diff <base>...<branch>`
                 * is the whole of its reading, and its own worktree is a clean checkout that is neither attempt
                 * — exactly the tree a merge of the two wants to start from. What comes out is a third branch,
                 * and that is the one you land.
                 *
                 * UNPINNED, so it runs on whatever you normally use. If you have a third provider connected,
                 * pinning it here is the upgrade: a judge from neither family has no house style to reward.
                 *
                 * AND IT DECLARES NO CHECK. The one it used to declare is why the rule is worth stating: it ran
                 * `pnpm -w test`, this repo's own command, shipped to everybody. Anywhere that is not a pnpm
                 * monorepo the check could never pass, so the step looped to its ceiling and failed a run that
                 * had built the thing twice and merged it correctly. Telling the model to run the project's own
                 * suite is the portable version of the same intent, and it is in the prompt. */
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`],
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the project's own tests pass.`,
                    prompt: SYNTHESIS_PROMPT,
                }),
            ],
        },
    },
    {
        icon: `list-check`,
        summary: `The same race, graded: a third model scores both diffs without knowing who wrote them, and the merge cannot finish until an independent judge accepts its verification.`,
        workflow: {
            id: `two-models-scored`,
            name: `Two models, scored and merged`,
            description: `One request built twice at once, then scored blind by a third model against the repository, and merged under a completion check that reads the score's requirements back.`,
            maxParallel: 2,
            steps: [
                ...attempts(),
                /* THE SCORING PASS, which is what this second card exists to show. It is a declared JSON output
                 * — six required fields — so what reaches the merge is evidence in a fixed shape rather than
                 * another essay, and it is pinned to a THIRD provider so neither family grades its own work.
                 * The cost is honest and is the reason this is not the default: a whole session, a full read of
                 * both diffs, and a completion gate that fails the step if the document comes out malformed. */
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
                /* THE CHECKED SYNTHESIS. Same merge as the simple card, plus the two things this card is here
                 * to demonstrate: it is handed the structured score as evidence (explicitly not as authority),
                 * and its own claim cannot end the step — a tool-less judge reads the report and sends it back
                 * unless the verification is named and run. A fixed shell command would guess a stranger's build
                 * system, so the verification is discovered by the worker and evidenced to the judge instead. */
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`, `evaluate`],
                    agent: `grok`,
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the project's own tests pass.`,
                    prompt:
                        `${SYNTHESIS_PROMPT}\n\n` +
                        `Treat the independent score above as evidence, not authority: verify every recommendation against the code before ` +
                        `acting on it, and satisfy every synthesis requirement it lists.`,
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
    /* THE THIRD CARD IS A DIFFERENT PROPOSITION FROM THE FIRST TWO: not a shape for work you start, but the
     * intelligent step a CI PIPELINE starts — which is why it ships with a gate already declared and pointed
     * at its only step, the intended small case. Deliberately one step: the pitch is the wiring (webhook in,
     * verdict out), and a reader who wants a security review or an acceptance sweep behind the same door adds
     * steps to this graph without touching the gate.
     *
     * ITS ROOT HAS A PROMPT, unlike every other root in the gallery, and that is the difference in caller: the
     * other templates are handed a person's request, which IS the task; a gate is handed whatever a pipeline
     * managed to interpolate — a sha, a branch, a URL — which is context that only becomes a task once the
     * step says what to do with it. */
    {
        icon: `shield`,
        summary: `The intelligent step for a CI pipeline. The pipeline POSTs what it knows — commit, branch, preview URL — to this workflow's own webhook, one session exercises the change and judges it, and the pipeline reads back pass, fail or blocked.`,
        workflow: {
            id: `release-gate`,
            name: `Release gate`,
            description: `Called by a pipeline over its webhook: a session inspects the change the pipeline named, judges whether it should ship, and answers with a verdict the pipeline can gate the release on.`,
            maxParallel: 1,
            steps: [
                step(`judge`, `Judge the change`, {
                    goal: `The change the pipeline named has been exercised against the workspace and a defensible verdict recorded.`,
                    prompt:
                        `A pipeline called this gate with everything it knows about a change — the text above: typically a commit, a branch, ` +
                        `sometimes a preview URL. Find that change in this workspace and exercise it the way a careful reviewer would: read the ` +
                        `diff against what it claims to do, build and test where the project says how, open the preview if one is named. Judge ` +
                        `only the change in front of you, not the codebase's general state.\n\n` +
                        `Write "pass" only for work you actually verified; write "fail" when the change is broken or falls short of what it ` +
                        `claims. If you cannot reach the work at all — the commit is not here, the preview does not answer — fail this step ` +
                        `rather than writing a verdict you never formed: the pipeline then reads "blocked", which is the honest answer.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `verdict`,
                                type: `string`,
                                description: `pass | fail — pass only when the change was exercised and found safe to ship`,
                                required: true,
                            },
                            {
                                name: `reason`,
                                type: `string`,
                                description: `one sentence on why — the only line of this the pipeline log will show`,
                                required: true,
                            },
                        ],
                    },
                }),
            ],
            gate: { step: `judge`, field: `verdict`, pass: [`pass`] },
        },
    },
];
