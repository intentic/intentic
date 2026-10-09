import type { EnvironmentNeed, Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract";
import type { AskContext, Gone, Met, NeedKindHandler, Resolved } from "../need-kinds.js";
import type { ToolStanding } from "../../environment/environment.js";

// A tool the agent needs in the sandbox image (docs/architecture/needs.md): its steps filed as a draft on the main tree
// at once, a card in the chat that asked, one tool approved at a time, and the conversation continued when the running
// container is the one built from that approval.

export interface EnvironmentNeedDeps {
    readonly propose: (tool: string, steps: string) => Promise<{ readonly file: string } | { readonly problem: string }>;
    readonly approve: (tool: string) => Promise<{ readonly hash: string | undefined } | { readonly problem: string }>;
    readonly reject: (tool: string) => Promise<void>;
    // Where the tool stands now (environment.ts toolStanding): built into the running container, a draft still waiting,
    // approved and waiting for a rebuild, or gone.
    readonly standing: (subject: EnvironmentNeed) => Promise<ToolStanding>;
    // The overlay composed now, for a tool found already approved when its card is answered.
    readonly composedHash: () => Promise<string | undefined>;
}

const metFor = (tool: string): Met => ({
    result: `${tool} is in the sandbox image now: this container was rebuilt with it.`,
    use: [`Use ${tool} directly; nothing needs installing again.`],
});

const goneFor = (tool: string): string =>
    `${tool} was turned down or taken out on the Environment card, so it will not be added; ask again with \`environment propose\` if it is still needed.`;

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
        // Met by any rebuild whose overlay carries the tool, however it was approved (this card, the Environment card's
        // Approve all, one approval among several before one rebuild); declined when it was turned down or taken out
        // somewhere else, rather than offering an Approve that has nothing left to approve.
        check: async (need): Promise<Met | Gone | undefined> => {
            const subject = subjectOf(need);
            if (subject === undefined) {
                return undefined;
            }
            const standing = await deps.standing(subject);
            if (standing === "built") {
                return metFor(subject.tool);
            }
            return standing === "gone" ? { gone: goneFor(subject.tool) } : undefined;
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "An environment proposal is answered by approving it, or declined." };
            }
            // Answered already somewhere else: the card catches up instead of refusing "no draft is waiting".
            const standing = await deps.standing(subject);
            if (standing === "built") {
                return { status: "met", ...metFor(subject.tool) };
            }
            if (standing === "gone") {
                return { status: "declined", result: goneFor(subject.tool) };
            }
            if (standing === "approved") {
                const hash = await deps.composedHash();
                return { status: "working", subject: { ...subject, ...(hash === undefined ? {} : { approvedHash: hash }) } };
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
