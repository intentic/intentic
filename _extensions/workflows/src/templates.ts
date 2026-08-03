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
 * worktrees, and a third session that reads both diffs and writes the version worth keeping. By hand that is
 * two chats, two branches, and a comparison you hold in your head from two transcripts you cannot read at once.
 *
 * AND IT TEACHES THE SHAPES IN THREE STEPS: a fan-out that IS the start of the run, a fan-in that reads what
 * both arms produced, steps declaring structured output for the one after them to act on, and a session
 * judging work it did not do — closed by a command gate. templates.test.ts asserts exactly that, so the claim
 * cannot quietly stop being true.
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
        summary: `What you type goes to Claude and to GPT at the same moment, each building it on a branch of its own. A third session then reads both diffs, keeps what each got right, and writes the merged version against your suite.`,
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
                 * worktree of your own, commit as you go — are now told to every step by the brief itself,
                 * because they are true of every step and no design should have to remember them.
                 *
                 * Same words, same output contract, different model, and neither is told the other exists — a
                 * session that knows it is being raced writes for the judge, and what you wanted to measure was
                 * how it writes code. Each gets its own worktree off HEAD and its own branch, which is what the
                 * comparison below actually reads.
                 *
                 * THE MODEL IS PINNED HERE AND IS THE ONLY DIFFERENCE BETWEEN THEM. Change either one in the
                 * designer (Advanced ▸ Runs on) — Grok against Claude, or the same provider twice on two
                 * different models — and the rest of the graph runs unchanged. The model VERSION is left unset
                 * on purpose: each provider's own default is the one your subscription actually serves, and a
                 * pinned id here would go stale and refuse to run.
                 */
                step(`attempt-a`, `Claude's attempt`, { agent: `claude` }),
                step(`attempt-b`, `GPT's attempt`, { agent: `codex` }),
                /* THE SYNTHESIS — one step, and it both reads and writes.
                 *
                 * It was two: a session that read the diffs and reported a verdict, then a continued session
                 * that wrote the merge from it. That split bought nothing. The two ran on one conversation
                 * anyway (`continue`), so it was never two opinions — just one session made to stop, publish a
                 * structured account of what it had just read, and be handed its own words back. The account
                 * was for nobody: no other step consumed it, and the reader who wants it has the diff.
                 *
                 * FRESH, so it wrote neither attempt and has no stake in either — the same reason a reviewer is
                 * a different session, and what makes this merge worth more than asking either author which one
                 * won. It is handed both documents and both BRANCH NAMES (the run supplies those), so
                 * `git diff main...<branch>` is the whole of its reading, and its own worktree is a clean
                 * checkout that is neither attempt — exactly the tree a merge of the two wants to start from.
                 * What comes out is a third branch, and that is the one you land.
                 *
                 * Unpinned, so it runs on whatever you normally use. If you have a third provider connected,
                 * pinning it here is the upgrade: a judge from neither family has no house style to reward.
                 *
                 * IT DECLARES NO CHECK, and the one it used to declare is why the rule is worth stating. It ran
                 * `pnpm -w test` — this repo's own command, shipped to everybody. In any workspace that is not a
                 * pnpm monorepo that command cannot succeed, so the check could never pass, so the step looped
                 * to its ceiling and failed, and a run that had built the thing twice and merged it correctly
                 * reported failure. A template ships to strangers' repos; a command in one is a guess about a
                 * tree nobody here has seen. Telling the model to run the suite is the portable version of the
                 * same intent, and it is in the prompt below. */
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`],
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the project's own tests pass.`,
                    prompt:
                        `Two sessions were given the request above and each built it, on the branches named above. Read both diffs in ` +
                        `full — the diffs, not the summaries of them — and judge them against what was asked and against the code they ` +
                        `had to live in, not against your own taste in style.\n\n` +
                        `Then write the version worth keeping, here in your own worktree. Start from the stronger of the two rather ` +
                        `than retyping it: bring its branch in with \`git merge --squash\`, then fix what it got wrong and fold in ` +
                        `whatever the other one did better. Run whatever this project uses to test itself and leave it passing. ` +
                        `What lands must read as one change somebody made on purpose, not as two ` +
                        `stitched together — and say, in a sentence each, what you took from where.`,
                }),
            ],
        },
    },
];
