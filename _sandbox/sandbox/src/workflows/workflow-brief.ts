import type { LoopDocument, WorkflowStep } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";

// What a step is told beyond its own loop brief (loop-brief.ts): that other sessions ran before it and what they
// concluded is why it is running. Spelled out rather than implied, since a fresh step would otherwise re-derive and
// disagree with its predecessors; a continued step gets it too, cheaply, once the reasoning is buried in tool output.

// Derived, not minted: a pure function of (run, step), so a conversation can be named before it exists.
const stepConversationId = (runId: string, stepId: string): string => `wf-${runId}-${stepId}`;

// A `continue` step shares its predecessor's conversation, the mechanism behind same agent, same worktree, next phase.
// Resolved eagerly, since the run record needs every conversation before the first step starts.
export const stepConversations = (runId: string, steps: readonly WorkflowStep[]): Map<string, string> => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const resolved = new Map<string, string>();
    const resolve = (step: WorkflowStep, seen: ReadonlySet<string>): string => {
        const cached = resolved.get(step.id);
        if (cached !== undefined) {
            return cached;
        }
        const parent = step.handoff === "continue" ? byId.get(step.needs[0] ?? "") : undefined;
        // `seen` guards a cycle save-time validation should refuse; failing here would kill a run valid when saved.
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
    // Full response artifact; `report` is only a ledger/UI preview so a long document isn't cut off downstream.
    readonly reportPath?: string;
    // Branches an isolated fresh step's work is on, so a reviewer diffs pinned base to branch instead of an empty
    // worktree read as clean. Three states, not two:
    // - undefined: shared tree or continued session, the question does not arise.
    // - non-empty: every entry resolved (handover-branches.ts), a diff against it shows something.
    // - empty: asked and answered nothing; stated so a reader doesn't go looking on their own.
    readonly branches?: readonly { readonly repo: string; readonly base: string; readonly branch: string }[];
}

// One upstream step's output, as the next step reads it; a `json` document leads with its data, since that's what the
// step was promised, with prose following as context.
const handoverFrom = ({ title, document, report, reportPath, branches }: Handover): string => {
    // The empty case changes reviewer behavior: reading the diff would waste a turn on a false all-clear.
    const where =
        branches === undefined
            ? []
            : branches.length === 0
              ? [
                    ``,
                    `It left no committed changes in any repository, so there is no diff to read. Judge it on what it said above and on the current state of the tree. Do not go looking for a branch of its work.`,
                ]
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
        // No document: the step declared `none` or ended invalid, so its closing words are all there is.
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

// No wrapper: never names the workflow, step index or worktree (the daemon commits it). Request and handovers are
// context, above; a declared prompt's own words come last, unlabeled unless something precedes them.
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
    // Root gets exactly the request, no heading: a request-less run is refused before this ever runs.
    if (step.prompt === undefined) {
        return [request ?? ``, ...settled].join(`\n\n`);
    }
    // Empty only when there is no request and no predecessors, so the step's own prompt is the whole message alone.
    const context = [...(request === undefined ? [] : [[`## What this run was asked to do`, ``, request].join(`\n`)]), ...settled];
    if (context.length === 0) {
        return step.prompt;
    }
    return [...context, [`## Your task`, ``, step.prompt].join(`\n`)].join(`\n\n`);
};
