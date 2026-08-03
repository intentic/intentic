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
 * AND IT TEACHES EVERY SHAPE AT ONCE, which is why one card does the work five did: a fan-out that IS the
 * start of the run, a fan-in that reads what both arms produced, a step declaring structured output for the
 * one after it to act on, a session judging work it did not do, and a continued chain finishing the job under
 * a command gate. templates.test.ts asserts exactly that, so the claim cannot quietly stop being true.
 */

export interface WorkflowTemplate {
    readonly icon: IconName;
    // The one-line pitch on the gallery card, and the thing that has to make the SHAPE legible: a user picks
    // from here by recognizing the shape of their own problem.
    readonly summary: string;
    readonly workflow: Workflow;
}

// Defaults every step shares unless it says otherwise. A step is mostly prose; these are the knobs that would
// otherwise be repeated forty times, and their values are the safe ones — eight iterations is a real
// convergence budget, two idle rounds catches a stall before it is expensive.
const step = (id: string, title: string, over: Partial<WorkflowStep> & Pick<WorkflowStep, "goal" | "prompt">): WorkflowStep => ({
    id,
    title,
    needs: [],
    handoff: `fresh`,
    output: { kind: `claim` },
    checks: [],
    context: `fresh`,
    maxIterations: 8,
    stallLimit: 2,
    maxSpendUsd: 5,
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
            // NOT NEGOTIABLE for this shape. Isolated is what gives each attempt its own worktree and its own
            // branch — without it the two would write over each other in /work, and there would be no two diffs
            // left to compare.
            isolated: true,
            // Two, which is the width of the fan-out AND the width of the run's first moment: both attempts
            // start at once, so a 1 here would silently make this a race with a false start.
            maxParallel: 2,
            maxSpendUsd: 25,
            steps: [
                /* THE TWO ATTEMPTS, AND THEY ARE WHERE THE RUN STARTS. Your request reaches both of them
                 * directly, at the same moment, as the first thing either session is told — which is what makes
                 * this feel like starting one agent rather than commissioning a project. It used to open with a
                 * step that turned the request into a brief for them, and that was a preamble sold as rigour:
                 * it spent a session and a minute before any code was written, and it inserted one model's
                 * reading of the task between you and both attempts, which is precisely the variable this
                 * design exists to hold still.
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
                    goal: `What was asked for is built, on this session's own branch.`,
                    prompt: `Build what the request above asks for. Read the code it touches before you change any of it. You are in a worktree of your own and nothing else is working in it, so commit as you go; follow the repo's own conventions rather than importing new ones, and stay inside what was actually asked for.`,
                    output: { kind: `json`, fields: attemptFields() },
                    maxIterations: 10,
                    maxSpendUsd: 10,
                }),
                step(`attempt-b`, `GPT's attempt`, {
                    agent: `codex`,
                    goal: `What was asked for is built, on this session's own branch.`,
                    prompt: `Build what the request above asks for. Read the code it touches before you change any of it. You are in a worktree of your own and nothing else is working in it, so commit as you go; follow the repo's own conventions rather than importing new ones, and stay inside what was actually asked for.`,
                    output: { kind: `json`, fields: attemptFields() },
                    maxIterations: 10,
                    maxSpendUsd: 10,
                }),
                /* THE FAN-IN. Fresh, so it wrote neither attempt and has no stake in either — the same reason a
                 * reviewer is a different session, and the reason this reading is worth more than asking either
                 * author which one won. It is handed two documents and two BRANCH NAMES (the run supplies those
                 * on an isolated workflow), so `git diff main...<branch>` is the whole of its reading.
                 *
                 * Unpinned, so it runs on whatever you normally use. If you have a third provider connected,
                 * pinning it here is the upgrade: a judge from neither family has no house style to reward. */
                step(`compare`, `Read both diffs`, {
                    needs: [`attempt-a`, `attempt-b`],
                    goal: `Both diffs have been read in full, and there is a specific account of what each one got right and wrong.`,
                    prompt: `Two sessions were given the request above and each built it, on the branches named above. Read both diffs in full — the diffs, not the summaries of them. Judge them against the brief and against the code they had to live in, not against your own taste in style. Be specific enough that someone could act on this without reading the diffs again.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `stronger`,
                                type: `string`,
                                description: `Which attempt is the better base to build on, and why, in one sentence`,
                                required: true,
                            },
                            {
                                name: `keep`,
                                type: `string[]`,
                                description: `Each decision worth keeping, naming the attempt it came from`,
                                required: true,
                            },
                            {
                                name: `drop`,
                                type: `string[]`,
                                description: `What either attempt got wrong, so the merge does not inherit it`,
                                required: true,
                            },
                        ],
                    },
                    maxIterations: 4,
                }),
                /* THE SYNTHESIS, CONTINUED — the one place in this graph where sharing a session is plainly
                 * right. It has just read both diffs; a fresh session here would be handed a summary of a
                 * reading it would have to do again. Continuing also means it writes in the comparison's own
                 * worktree — a clean checkout that is neither attempt, which is exactly the tree a merge of the
                 * two wants to start from. What comes out is a third branch, and that is the one you land. */
                step(`merge`, `Write the better version`, {
                    needs: [`compare`],
                    handoff: `continue`,
                    context: `continue`,
                    goal: `One coherent implementation exists that keeps everything you said to keep, and the suite is green.`,
                    prompt: `Now write the version you just argued for, here in your own worktree. Start from the stronger attempt rather than retyping it: the two are on branches ending \`-attempt-a\` and \`-attempt-b\` (\`git branch --list 'agent/wf-*'\` finds them), so bring the better one in with \`git merge --squash\` and apply your keep and drop list on top of it. What lands must read as one change somebody made on purpose, not as two stitched together.`,
                    output: { kind: `none` },
                    checks: [{ kind: `command`, command: `pnpm -w test` }],
                    maxIterations: 10,
                    maxSpendUsd: 10,
                }),
            ],
        },
    },
];
