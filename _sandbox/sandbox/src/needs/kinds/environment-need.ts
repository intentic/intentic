import type { EnvironmentNeed, Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A tool the agent needs in the sandbox image (docs/architecture/needs.md): its steps filed as a draft on the main tree
// at once, a card in the chat that asked, one tool approved at a time, and the conversation continued when the running
// container is the one built from that approval.

export interface EnvironmentNeedDeps {
    readonly propose: (tool: string, steps: string) => Promise<{ readonly file: string } | { readonly problem: string }>;
    readonly approve: (tool: string) => Promise<{ readonly hash: string | undefined } | { readonly problem: string }>;
    readonly reject: (tool: string) => Promise<void>;
    // The overlay this container was built from; met once it equals the one a need was approved into.
    readonly appliedHash: () => string;
}

export const environmentNeed = (deps: EnvironmentNeedDeps): NeedKindHandler => {
    const resolve = async (ask: NeedAsk, _context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "environment") {
            return { kind: "refused", code: "invalid", message: "Not an environment ask." };
        }
        const filed = await deps.propose(ask.tool, ask.steps);
        if ("problem" in filed) {
            return { kind: "refused", code: "invalid_steps", message: `Nothing was proposed: ${filed.problem}.` };
        }
        const subject: EnvironmentNeed = { kind: "environment", tool: ask.tool, steps: ask.steps.trim() };
        return { kind: "raise", subject, title: `Add ${ask.tool} to the sandbox image` };
    };

    const subjectOf = (need: Need): EnvironmentNeed | undefined => (need.subject.kind === "environment" ? need.subject : undefined);

    return {
        resolve,
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            if (subject?.approvedHash === undefined || deps.appliedHash() !== subject.approvedHash) {
                return undefined;
            }
            return { result: `${subject.tool} is in the sandbox image now: this container was rebuilt with it.`, use: [`Use ${subject.tool} directly; nothing needs installing again.`] };
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "An environment proposal is answered by approving it, or declined." };
            }
            const approved = await deps.approve(subject.tool);
            if ("problem" in approved) {
                return { refused: `It cannot be approved: ${approved.problem}.` };
            }
            // Approved into the overlay; met once a rebuild puts it on the running container.
            return { status: "working", subject: { ...subject, ...(approved.hash === undefined ? {} : { approvedHash: approved.hash }) } };
        },
        declined: async (need) => {
            const subject = subjectOf(need);
            if (subject !== undefined) {
                await deps.reject(subject.tool);
            }
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "environment" ? subject.tool.toLowerCase() : ""),
    };
};
