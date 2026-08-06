import type { LoopDocument, WorkflowStep } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";

/* WHAT A STEP IS TOLD, over and above what its loop already tells it.
 *
 * The loop's own brief (loop-brief.ts) covers the goal, the memory rule and the output contract. This file
 * covers the one thing a loop has no concept of: that other sessions ran before this one, and that what they
 * concluded is the reason it is running.
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
    // Complete response artifact. `report` is deliberately only a ledger/UI preview; a downstream session must
    // be able to consume a long analysis or document without its middle silently disappearing.
    readonly reportPath?: string;
    /* The branch the upstream step's work is on, for an ISOLATED run where this step is a fresh session.
     *
     * This closes what would otherwise be a silent hole in the whole design. In an isolated run every fresh
     * step gets its own worktree off the run's pinned repository snapshot, so a reviewer told "check the implementation" opens a tree that
     * contains no implementation, finds nothing wrong, and says so — a green review of work it never saw,
     * which is worse than no review. Naming the branch turns that into the thing it should have been all
     * along: `git diff <pinned-base>...<branch>` is what reviewing a change actually is, and it works precisely
     * BECAUSE the sessions are separate.
     *
     * Absent on a shared-tree run, where the work is simply there, and absent when the step is continuing the
     * same session, where it is already in the worktree the step is standing in.
     */
    readonly branches?: readonly { readonly repo: string; readonly base: string; readonly branch: string }[];
}

// One upstream step's output, as the next step reads it. A `json` document leads with its data because that is
// what the step was promised and what it is expected to act on; the prose follows as context.
const handoverFrom = ({ title, document, report, reportPath, branches }: Handover): string => {
    const where =
        branches === undefined
            ? []
            : [
                  ``,
                  `Its work is on the following branches. Each command compares against this run's exact starting commit, not against a branch name that may have moved:`,
                  ...branches.map(({ repo, base, branch }) =>
                      repo === "root"
                          ? `- workspace root: \`git diff ${base}...${branch}\``
                          : `- \`${repo}\`: \`git -C ${shellQuote(repo)} diff ${base}...${branch}\``,
                  ),
              ];
    const full =
        reportPath === undefined
            ? []
            : [``, `Its complete response is in \`${reportPath}\`. Read that file before acting; the text below is only a preview.`];
    if (document === undefined) {
        // No document: either the step declared `none`, or it ended without writing a valid one. Its closing
        // words are all there is. The complete artifact prevents long-form work from becoming a 4,000-character
        // tail; this bounded text keeps the prompt itself readable.
        return [`### From "${title}"`, ...full, ``, report.trim() || `(this step finished without saying anything)`, ...where].join(`\n`);
    }
    return [
        `### From "${title}"`,
        ``,
        document.reason,
        ...(document.evidence !== undefined ? [``, `Evidence: ${document.evidence}`] : []),
        ...(document.data !== undefined ? [``, `\`\`\`json`, JSON.stringify(document.data, undefined, 2), `\`\`\``] : []),
        ...full,
        ...where,
    ].join(`\n`);
};

/* The prompt a step's loop is given. Becomes `Loop.prompt` — and for the ordinary step that is the WHOLE turn
 * prompt, because a step with nothing to produce and nothing to check gets no loop framing either (loop-brief's
 * `singleTurn`).
 *
 * A STEP THAT DECLARES NO PROMPT IS HANDED THE REQUEST AND NOTHING ELSE. Not "almost nothing" — nothing. A root
 * step of a design written as a shape receives the sentence the person typed, byte for byte, exactly as if they
 * had sent it to one agent. Every heading is a thing standing between the reader and the model, and a model
 * handed a page about workflows spends some of its attention on workflows; a step whose entire job is "do what
 * was asked" has nothing to add to the asking.
 *
 * NOTHING IS SAID ABOUT THE WORKFLOW ITSELF, EVER, and that is the rule the rest of this file follows. A step
 * used to open with its own title, then "this is step 2 of 3 in the workflow **Two models, one task** —" and
 * the design's whole one-line description, then a paragraph explaining which of the two instructions below won
 * where they disagreed. None of it is the job. Which step of what is the SCHEDULER's bookkeeping: the model
 * cannot act on being second, it has already been handed everything the first one concluded, and a session
 * told it is one arm of a comparison writes for the comparison. What is left is what a person would have
 * typed: the request, what is already settled, and this step's own instruction.
 *
 * NOTHING NEEDS TO BE SAID ABOUT THE WORKTREE, which is worth writing down because it is not obvious and it was
 * got wrong here. A step does run isolated, and the step after it reads an exact pinned-base-to-branch diff —
 * but the daemon commits the worktree onto that branch itself at clean turn completion (agents/land.ts, in
 * both `check` and `measure` modes). Telling the model to commit was instructing it to do something already
 * done for it, at the cost of the one thing this default exists to protect.
 *
 * A STEP THAT DECLARES A PROMPT IS SAYING IT HAS A JOB OF ITS OWN — review this, merge those — so ITS words go
 * last, where the instruction belongs, with the request and the handovers above them as the context they are
 * for that step. Two words of heading over it, and only when something IS above it: a block of instruction
 * running straight on from "what the steps before you concluded" reads as more of what was concluded. That is
 * the whole of the framing — a label saying which of these is the ask, not a paragraph explaining it.
 *
 * THE REQUEST GOES TO EVERY STEP EITHER WAY, not only to the roots, and above the handovers. A workflow is a
 * shape and the request is what it is pointed at this time, so a step three down is not working from a summary
 * of a summary: the reviewer reads "make the importer handle empty files" and can tell whether what it is
 * looking at is that. It is short, the same text for every step, and cached — the cheapest context in the whole
 * brief and the only one that says what any of this is FOR.
 */
export const briefForStep = (step: WorkflowStep, handovers: readonly Handover[], request?: string): string => {
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
    /* Inheriting: the request IS the instruction. A root step therefore gets the request and NOTHING — not a
     * heading over it, since a heading over the only thing in a message is furniture. A run that would arrive
     * here with no request at all is refused before it starts (workflowRunFaults), which is what lets this be
     * the plain string rather than a third case.
     *
     * A step further down still gets its predecessors' conclusions, and that is the line between "no wrapper"
     * and "no context": dropping the framing is the point, dropping the facts would just make the step
     * re-derive them and disagree. */
    if (step.prompt === undefined) {
        return [request ?? ``, ...settled].join(`\n\n`);
    }
    // What this step's own instruction is being handed on top of. Empty only for a run with no request and no
    // predecessors, where the step's prompt is the entire message and a heading over it would be furniture.
    const context = [...(request === undefined ? [] : [[`## What this run was asked to do`, ``, request].join(`\n`)]), ...settled];
    if (context.length === 0) {
        return step.prompt;
    }
    return [...context, [`## Your task`, ``, step.prompt].join(`\n`)].join(`\n\n`);
};
