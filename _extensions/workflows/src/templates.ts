import type { IconName } from "@intentic/extension-ui";
import type { OutputField, Workflow, WorkflowStep } from "@intentic/sandbox-contract";

/* "START FROM" — ready-made workflows, the same idea as the automations recipes and for the same reason: this
 * is a feature nobody designs well on a blank canvas, because the interesting decisions (where to break the
 * session, what each step must produce, what checks the work) are not obvious until you have seen a few.
 *
 * PURE PREFILL. The daemon knows nothing about templates; picking one opens the designer with a real workflow
 * in it, which you then edit and save. Never "create it silently and hope" — a workflow costs money to run
 * and the whole point of the designer is that you look at the graph before you press go.
 *
 * THE FIVE ARE CHOSEN BY SHAPE, not by topic. Each one demonstrates a structure that is hard to discover and
 * easy to reuse — a continued chain, a lone convergence loop, a fan-out with a fan-in, a producer feeding a
 * consumer structured data, and an independent reviewer. A gallery of five variations on "do a task" would
 * teach nothing, and the topics are the easy part to change.
 */

export interface WorkflowTemplate {
    readonly icon: IconName;
    // The one-line pitch on the gallery card, and the thing that has to make the SHAPE legible: a user picks
    // from here by recognizing the shape of their own problem.
    readonly summary: string;
    readonly workflow: Workflow;
}

// Defaults every template's steps share unless they say otherwise. A step is mostly prose; these are the knobs
// that would otherwise be repeated forty times, and their values are the safe ones — eight iterations is a
// real convergence budget, two idle rounds catches a stall before it is expensive.
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

// The audit steps all report the same shape, and they must: the merge step downstream reads three documents
// and can only dedupe them if they are the same shape. A function rather than a shared constant because each
// step holds its own copy — a template is prefill, and the user editing one auditor's fields must not silently
// edit the others'.
const findingsFields = (): OutputField[] => [
    { name: `findings`, type: `string[]`, description: `One line per finding: what, where (file:line), and why it matters`, required: true },
    { name: `worst`, type: `string`, description: `The single finding you would fix first, or "none"`, required: true },
    { name: `checked`, type: `string`, description: `What you actually looked at, so the merge step knows the coverage`, required: true },
];

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
    {
        icon: `sparkles`,
        summary: `Plan it, build it, test it — one agent on one branch — then hand the diff to a reviewer who did none of the work.`,
        workflow: {
            id: `ship-a-change`,
            name: `Ship a change`,
            description: `A continued chain that builds on itself, closed by an independent review of the branch.`,
            isolated: true,
            maxParallel: 2,
            maxSpendUsd: 20,
            steps: [
                step(`plan`, `Plan the change`, {
                    goal: `There is a concrete plan naming the files to change and how the change will be verified.`,
                    prompt: `Read the code this change touches and write a plan. Name the specific files, say what each one needs, and say how you will know it works. Do not write any code in this step.`,
                    output: {
                        kind: `json`,
                        fields: [
                            { name: `files`, type: `string[]`, description: `Workspace-relative paths this change will touch`, required: true },
                            { name: `approach`, type: `string`, description: `Two or three sentences: how the change works`, required: true },
                            { name: `verification`, type: `string`, description: `The command or observation that proves it works`, required: true },
                        ],
                    },
                }),
                // Continued, so it inherits the plan's session AND its worktree — the two things "build on the
                // last step" actually means.
                step(`build`, `Make the change`, {
                    needs: [`plan`],
                    handoff: `continue`,
                    context: `continue`,
                    goal: `The change from the plan is implemented, and it compiles.`,
                    prompt: `Implement the plan you just wrote. Follow the repo's own conventions rather than importing new ones.`,
                    output: { kind: `none` },
                    checks: [{ kind: `command`, command: `pnpm -w typecheck` }],
                    maxSpendUsd: 10,
                }),
                step(`test`, `Prove it works`, {
                    needs: [`build`],
                    handoff: `continue`,
                    context: `continue`,
                    goal: `The change is covered by a test that fails without it, and the suite is green.`,
                    prompt: `Add the test the plan named as verification, then run the suite. If it fails, fix the code — not the test.`,
                    output: { kind: `none` },
                    checks: [{ kind: `command`, command: `pnpm -w test` }],
                    maxSpendUsd: 10,
                }),
                /* FRESH, deliberately, and this is the step the whole template exists to demonstrate. A session
                 * that spent three phases arguing for an approach is the worst available judge of it. This one
                 * has never seen the reasoning — only the diff on the branch, which the run hands it. */
                step(`review`, `Review the diff`, {
                    needs: [`test`],
                    goal: `Someone who did not write this change has read the whole diff and said whether it is sound.`,
                    prompt: `Review the branch named above, in full. You did not write this and have no stake in it being good. Report what is wrong, or say plainly that nothing is.`,
                    output: {
                        kind: `json`,
                        fields: [
                            { name: `verdict`, type: `string`, description: `ship | fix-first | rework`, required: true },
                            { name: `problems`, type: `string[]`, description: `One line per real problem, worst first`, required: false },
                        ],
                    },
                    maxIterations: 3,
                }),
            ],
        },
    },
    {
        icon: `check-circle`,
        summary: `One step, looping: run the suite, fix the top failure, repeat until it is green or it stops making progress.`,
        workflow: {
            id: `make-it-green`,
            name: `Make the suite green`,
            description: `The plain Ralph loop, as a workflow — the shape everything else here is built out of.`,
            isolated: true,
            maxParallel: 1,
            maxSpendUsd: 15,
            steps: [
                step(`fix`, `Fix the failures`, {
                    goal: `The whole test suite passes.`,
                    prompt: `Run the suite. Take the single most-blocking failure, understand it, fix the code. Do not weaken a test to make it pass, and do not skip one.`,
                    output: { kind: `none` },
                    checks: [{ kind: `command`, command: `pnpm -w test` }],
                    maxIterations: 15,
                    stallLimit: 3,
                    maxSpendUsd: 15,
                }),
            ],
        },
    },
    {
        icon: `shield`,
        summary: `Three independent auditors read the same code at the same time, then a fourth session merges what they found into one list.`,
        workflow: {
            id: `release-audit`,
            name: `Audit before release`,
            description: `A fan-out of independent reviewers, closed by a fan-in that dedupes and ranks.`,
            // Shared tree: every auditor is READING, so there is nothing to collide over and each one sees the
            // workspace exactly as it is rather than a checkout of main.
            isolated: false,
            maxParallel: 3,
            maxSpendUsd: 15,
            steps: [
                step(`security`, `Security pass`, {
                    goal: `Every place this codebase handles a secret, an input from outside, or a permission has been looked at.`,
                    prompt: `Audit for security problems: unvalidated external input, secrets that could be logged or served, permission checks that can be bypassed. Report only what you can point at a line for.`,
                    output: { kind: `json`, fields: findingsFields() },
                    maxIterations: 4,
                }),
                step(`deps`, `Dependency pass`, {
                    goal: `The dependency tree has been checked for advisories, abandonment and duplication.`,
                    prompt: `Audit the dependencies: known advisories, packages that are unmaintained, and duplicate copies of one library at different versions.`,
                    output: { kind: `json`, fields: findingsFields() },
                    maxIterations: 4,
                }),
                step(`dead`, `Dead code pass`, {
                    goal: `Exports, files and flags nothing reaches have been identified.`,
                    prompt: `Find code nothing reaches: unexported-but-unused symbols, files nothing imports, feature flags that are permanently on. Verify each one is genuinely unreferenced before reporting it.`,
                    output: { kind: `json`, fields: findingsFields() },
                    maxIterations: 4,
                }),
                /* The fan-in is what makes a fan-out worth having. Three auditors produce three lists that
                 * overlap, disagree about severity and use different words for the same thing; a human merging
                 * them by hand is most of the work the audit was supposed to save. */
                step(`merge`, `One list`, {
                    needs: [`security`, `deps`, `dead`],
                    goal: `The three audits are one ranked list with no duplicates.`,
                    prompt: `You have three audits above. Merge them: drop duplicates, resolve disagreements about severity by looking at the code yourself, and rank what is left by what would actually hurt.`,
                    output: {
                        kind: `json`,
                        fields: [
                            { name: `blocking`, type: `string[]`, description: `Findings that should stop a release, worst first`, required: true },
                            { name: `later`, type: `string[]`, description: `Real but not blocking`, required: false },
                            { name: `summary`, type: `string`, description: `Two sentences: is this releasable?`, required: true },
                        ],
                    },
                    maxIterations: 3,
                }),
            ],
        },
    },
    {
        icon: `search`,
        summary: `Reproduce the bug and write down exactly what fails, then fix it against that description and lock it in with a test.`,
        workflow: {
            id: `triage-a-bug`,
            name: `Triage and fix a bug`,
            description: `A producer that must hand over structured facts before anyone is allowed to start fixing.`,
            isolated: true,
            maxParallel: 1,
            maxSpendUsd: 15,
            steps: [
                /* The structured output is the point of this template. "Reproduce it" as prose gets you a
                 * paragraph; as declared fields it gets you a failing command the next step can run, which is
                 * the difference between a fix aimed at the bug and a fix aimed at a description of it. */
                step(`reproduce`, `Reproduce it`, {
                    goal: `There is a command that fails, and the failure is understood.`,
                    prompt: `Reproduce the reported problem. Do not fix anything. Find the smallest command that shows it failing and the line where it goes wrong.`,
                    output: {
                        kind: `json`,
                        fields: [
                            { name: `command`, type: `string`, description: `The smallest command that shows the failure`, required: true },
                            { name: `location`, type: `string`, description: `file:line where it actually goes wrong`, required: true },
                            { name: `cause`, type: `string`, description: `One or two sentences: why it fails`, required: true },
                        ],
                    },
                    maxIterations: 6,
                }),
                step(`fix`, `Fix the cause`, {
                    needs: [`reproduce`],
                    handoff: `continue`,
                    context: `continue`,
                    goal: `The command from the previous step passes, and the cause named there is gone.`,
                    prompt: `Fix the cause you identified — not the symptom. Then run the command you found until it passes.`,
                    output: { kind: `claim` },
                    maxIterations: 8,
                }),
                step(`regress`, `Lock it in`, {
                    needs: [`fix`],
                    handoff: `continue`,
                    context: `continue`,
                    goal: `A test exists that fails on the old code and passes on the new, and the whole suite is green.`,
                    prompt: `Write the regression test for this bug. Prove it fails without your fix (revert it briefly if you need to), then run the whole suite.`,
                    output: { kind: `none` },
                    checks: [{ kind: `command`, command: `pnpm -w test` }],
                }),
            ],
        },
    },
    {
        icon: `file`,
        summary: `Survey what is undocumented and pick what is worth writing, then write only those — reviewed against the code, not against itself.`,
        workflow: {
            id: `document-a-repo`,
            name: `Document a repository`,
            description: `A survey that decides the work, a writer that does it, and a judge that has to be convinced.`,
            isolated: true,
            maxParallel: 1,
            maxSpendUsd: 15,
            steps: [
                step(`survey`, `Find what is missing`, {
                    goal: `The packages worth documenting are named, in the order they should be written.`,
                    prompt: `Survey this repository. Which packages have no document, or one that no longer matches the code? Rank by how much a newcomer would need it. Write nothing but the survey.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `packages`,
                                type: `string[]`,
                                description: `Paths of the packages worth documenting, most valuable first`,
                                required: true,
                            },
                            { name: `reason`, type: `string`, description: `Why these and not the others`, required: true },
                        ],
                    },
                    maxIterations: 3,
                }),
                /* A judge rather than a command, because there is no command that can check prose. It reads the
                 * writer's own account and rules against a rubric, having written none of it — the same rule the
                 * reviewer in "Ship a change" follows, applied where no test could. */
                step(`write`, `Write them`, {
                    needs: [`survey`],
                    handoff: `continue`,
                    context: `fresh`,
                    goal: `Each package named in the survey has a document that explains what it is for and how it fits together.`,
                    prompt: `Write the documents the survey asked for, one at a time, following this workspace's documentation conventions. Read the code first — a document that restates the file names is worse than none.`,
                    output: { kind: `claim` },
                    checks: [
                        {
                            kind: `judge`,
                            rubric: `Every package the survey named has a document that explains what the package is FOR and why it is shaped the way it is — not a list of its files, and not a paraphrase of its exports.`,
                        },
                    ],
                    maxIterations: 10,
                    maxSpendUsd: 12,
                }),
            ],
        },
    },
];
