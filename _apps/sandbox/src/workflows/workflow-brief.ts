import type { LoopDocument, Workflow, WorkflowStep } from "@intentic/sandbox-contract";

/* WHAT A STEP IS TOLD, over and above what its loop already tells it.
 *
 * The loop's own brief (loop-brief.ts) covers the goal, the iteration number, the memory rule and the output
 * contract — everything about repeating. This file covers the one thing a loop has no concept of: that this
 * session is part of something, that other sessions ran before it, and that what they concluded is the reason
 * this one is running.
 *
 * WHY THE HANDOFF IS SPELLED OUT RATHER THAN IMPLIED. A `fresh` step's session has never seen the workflow, so
 * without this it reads its prompt as a standalone request and cheerfully re-derives everything the previous
 * three steps established — which is not just waste, it is DISAGREEMENT: a step that re-decides which files
 * matter will pick a different set than the step that was supposed to have decided it, and the two halves of
 * the run then describe different work. Being handed a predecessor's output and being told it is settled is
 * what makes a chain a chain rather than four independent attempts at the same job.
 *
 * WHY IT GOES IN EVEN WHEN THE SESSION IS CONTINUED. A `continue` step's model has the predecessor's reasoning
 * in its transcript already, so this is redundant — for about two steps. By the third it is behind a wall of
 * tool output, and restating it costs a few hundred tokens against a prefix that is cached anyway.
 */

// A step's conversation: derived, not minted, so the id is a pure function of (run, step). Which means the
// scheduler can name a step's conversation before it exists, the boot resume can find it again without a
// second store, and the run view can link to a transcript for a step that has not started. Same bet the
// acceptance extension makes with `xt-<runId>-<slug>`.
const stepConversationId = (runId: string, stepId: string): string => `wf-${runId}-${stepId}`;

/* Which conversation each step runs on, for a whole workflow at once.
 *
 * A `continue` step does NOT get its own — it takes its single predecessor's, and that sharing is the entire
 * mechanism behind "same agent, same worktree, next phase". Resolved in one pass over the steps in dependency
 * order rather than lazily, because the run record needs every step's conversation written down before the
 * first one starts: a graph whose nodes cannot be linked to a transcript until they run is a graph you cannot
 * follow while it is running, which is when you want to.
 */
export const stepConversations = (runId: string, steps: readonly WorkflowStep[]): Map<string, string> => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const resolved = new Map<string, string>();
    const resolve = (step: WorkflowStep, seen: ReadonlySet<string>): string => {
        const cached = resolved.get(step.id);
        if (cached !== undefined) {
            return cached;
        }
        const parent = step.handoff === "continue" ? byId.get(step.needs[0] ?? "") : undefined;
        // `seen` is belt-and-braces against a cycle the save-time validation should already have refused —
        // this runs on a snapshot inside a run, where throwing would take the whole run down over a graph that
        // was legal when it was saved.
        const id = parent !== undefined && !seen.has(parent.id) ? resolve(parent, new Set([...seen, step.id])) : stepConversationId(runId, step.id);
        resolved.set(step.id, id);
        return id;
    };
    for (const step of steps) {
        resolve(step, new Set());
    }
    return resolved;
};

export interface Handover {
    readonly title: string;
    readonly document: LoopDocument | undefined;
    readonly report: string;
    /* The branch the upstream step's work is on, for an ISOLATED run where this step is a fresh session.
     *
     * This closes what would otherwise be a silent hole in the whole design. In an isolated run every fresh
     * step gets its own worktree off main, so a reviewer told "check the implementation" opens a tree that
     * contains no implementation, finds nothing wrong, and says so — a green review of work it never saw,
     * which is worse than no review. Naming the branch turns that into the thing it should have been all
     * along: `git diff main...<branch>` is what reviewing a change actually is, and it works precisely BECAUSE
     * the sessions are separate.
     *
     * Absent on a shared-tree run, where the work is simply there, and absent when the step is continuing the
     * same session, where it is already in the worktree the step is standing in.
     */
    readonly branch?: string;
}

// One upstream step's output, as the next step reads it. A `json` document leads with its data because that is
// what the step was promised and what it is expected to act on; the prose follows as context.
const handoverFrom = ({ title, document, report, branch }: Handover): string => {
    const where =
        branch === undefined ? [] : [``, `Its work is on the branch \`${branch}\` — \`git diff main...${branch}\` is exactly what it changed.`];
    if (document === undefined) {
        // No document: either the step declared `none`, or it ended without writing a valid one. Its closing
        // words are all there is, and truncating from the END keeps the conclusion rather than the preamble.
        return [`### From "${title}"`, ``, report.slice(-4_000).trim() || `(this step finished without saying anything)`, ...where].join(`\n`);
    }
    return [
        `### From "${title}"`,
        ``,
        document.reason,
        ...(document.evidence !== undefined ? [``, `Evidence: ${document.evidence}`] : []),
        ...(document.data !== undefined ? [``, `\`\`\`json`, JSON.stringify(document.data, undefined, 2), `\`\`\``] : []),
        ...where,
    ].join(`\n`);
};

/* WHERE THE SESSION IS STANDING, on every step, and it is here rather than in any step's prose for a reason
 * that cost the one template we ship.
 *
 * Every workflow step runs in a worktree of its own — always, no toggle (WorkflowSchema) — and NOTHING ELSE
 * SAYS SO. The sandbox's system prompt is silent about isolation, so a step knew only if its author had
 * remembered to write it down, and the two-models template was the thing carrying that sentence. What it
 * guards against fails silently and completely: the step downstream reads its predecessors with
 * `git diff main...<branch>`, so an attempt that did the work and left it uncommitted hands the merge an empty
 * diff, and the merge truthfully reports that one attempt did nothing. One line, on every step, so no design
 * can omit it and no design has to remember it.
 */
const WHERE_YOU_ARE = [
    `## Where you are working`,
    ``,
    `You are in a git worktree of your own and nothing else is working in it. The steps after you read what you ` +
        `did with \`git diff main...<your branch>\` — so COMMIT AS YOU GO. Anything you leave uncommitted is ` +
        `invisible to the rest of this run.`,
].join(`\n`);

/* The prompt a step's loop is given. Becomes `Loop.prompt`, so the loop wraps it with the iteration heading,
 * the goal and the output contract — this is only the task half.
 *
 * A STEP THAT DECLARES NO PROMPT GETS THE REQUEST AND ALMOST NOTHING ELSE, and that default is the whole point.
 * The headings below are not free: each one stands between the sentence the reader typed and the model that has
 * to act on it, and a model handed a five-section brief about a workflow will spend some of its attention on
 * the workflow. A step whose entire job is "do what was asked" has nothing to add to the asking, so it adds
 * nothing — the request, whatever its predecessors settled, and where it is standing. That is what makes a
 * saved workflow a SHAPE you point at today's job rather than a document you edit in order to ask a question.
 *
 * A STEP THAT DECLARES ONE IS SAYING IT HAS A JOB OF ITS OWN — review this, merge those — and gets the full
 * brief, because for that step the request genuinely is context rather than the instruction.
 *
 * THE REQUEST GOES TO EVERY STEP EITHER WAY, not only to the roots, and above the handovers. A workflow is a
 * shape and the request is what it is pointed at this time, so a step three down is not working from a summary
 * of a summary: the reviewer reads "make the importer handle empty files" and can tell whether what it is
 * looking at is that. It is short, the same text for every step, and cached — the cheapest context in the whole
 * brief and the only one that says what any of this is FOR.
 */
export const briefForStep = (workflow: Workflow, step: WorkflowStep, position: number, handovers: readonly Handover[], request?: string): string => {
    const settled =
        handovers.length === 0
            ? []
            : [
                  [
                      `## What the steps before you concluded`,
                      ``,
                      `Treat this as SETTLED. It was decided by sessions that did that work, and re-litigating it is how a ` +
                          `workflow ends up describing two different jobs. If it is wrong, say so in your output rather than ` +
                          `quietly working around it.`,
                      ``,
                      ...handovers.map(handoverFrom),
                  ].join(`\n`),
              ];
    /* Inheriting: the request IS the instruction, so it leads and wears no heading — a heading over the only
     * thing in the brief is furniture. A run that would arrive here with no request at all is refused before it
     * starts (workflowRunFaults), which is what lets this be the plain string rather than a third case. */
    if (step.prompt === undefined) {
        return [request ?? ``, ...settled, WHERE_YOU_ARE].join(`\n\n`);
    }
    return [
        [
            `# ${step.title}`,
            ``,
            `This is step ${position} of ${workflow.steps.length} in the workflow **${workflow.name}**` +
                `${workflow.description !== undefined ? ` — ${workflow.description}` : ``}.`,
        ].join(`\n`),
        ...(request === undefined
            ? []
            : [
                  [
                      `## What this run was asked to do`,
                      ``,
                      `The person who started this run wrote the following. Everything below serves it, and where your own ` +
                          `step's instructions and this disagree, this is the one that is about today's job.`,
                      ``,
                      request,
                  ].join(`\n`),
              ]),
        ...settled,
        [`## Your task`, ``, step.prompt].join(`\n`),
        WHERE_YOU_ARE,
    ].join(`\n\n`);
};
