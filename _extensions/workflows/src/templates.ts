import type { IconName } from "@intentic/extension-ui";
import type { OutputField, Workflow, WorkflowStep } from "@intentic/sandbox-contract";

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
    output: { kind: `claim` },
    checks: [],
    context: `fresh`,
    ...over,
});

// Both attempts report the same shape, and they must: the comparison downstream reads two documents and can
// only weigh them against each other if they answered the same questions. A function rather than a shared
// constant because each step holds its own copy — a template is prefill, and the user editing one attempt's
// fields must not silently edit the other's.
const attemptFields = (): OutputField[] => [
    { name: `approach`, type: `string`, description: `Two or three sentences: how your version works`, required: true },
    { name: `files`, type: `string[]`, description: `Workspace-relative paths you changed`, required: true },
    { name: `tradeoffs`, type: `string`, description: `What you deliberately did not do, and why`, required: true },
    { name: `risk`, type: `string`, description: `The part of your change most likely to be wrong`, required: true },
];

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
                step(`attempt-a`, `Claude's attempt`, {
                    agent: `claude`,
                    output: { kind: `json`, fields: attemptFields() },
                }),
                step(`attempt-b`, `GPT's attempt`, {
                    agent: `codex`,
                    output: { kind: `json`, fields: attemptFields() },
                }),
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
                 * pinning it here is the upgrade: a judge from neither family has no house style to reward. */
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`],
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the suite is green.`,
                    prompt:
                        `Two sessions were given the request above and each built it, on the branches named above. Read both diffs in ` +
                        `full — the diffs, not the summaries of them — and judge them against what was asked and against the code they ` +
                        `had to live in, not against your own taste in style.\n\n` +
                        `Then write the version worth keeping, here in your own worktree. Start from the stronger of the two rather ` +
                        `than retyping it: bring its branch in with \`git merge --squash\`, then fix what it got wrong and fold in ` +
                        `whatever the other one did better. What lands must read as one change somebody made on purpose, not as two ` +
                        `stitched together — and say, in a sentence each, what you took from where.`,
                    checks: [{ kind: `command`, command: `pnpm -w test` }],
                }),
            ],
        },
    },
];
