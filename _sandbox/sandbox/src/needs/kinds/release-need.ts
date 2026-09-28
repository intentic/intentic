import type { CredentialGate, Need, NeedAsk, NeedSubject, ReleaseNeed } from "@intentic/sandbox-contract";
import type { CredentialGrants } from "../../secrets/credential-grants.js";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A gated account or connector, released to the rest of a conversation by a named approver (the `secrets request`
// door, docs/architecture/needs.md). As a need it survives the turn that asked: the approver can answer an hour later
// and the conversation is continued with the account mounted, rather than the ask expiring after ten minutes unseen.

export interface ReleaseNeedDeps {
    readonly gates: () => Promise<readonly CredentialGate[]>;
    // Whether anything goes by this name at all: a stored secret, or a connected account or connector.
    readonly exists: (subject: string) => Promise<boolean>;
    // Read when asked, never when this is built.
    readonly grants: () => CredentialGrants;
    readonly now?: () => number;
}

const names = (approvers: readonly string[]): string => approvers.join(" or ");

export const releaseNeed = (deps: ReleaseNeedDeps): NeedKindHandler => {
    const now = deps.now ?? Date.now;
    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "release") {
            return { kind: "refused", code: "invalid", message: "Not a release ask." };
        }
        const gate = (await deps.gates()).find((entry) => entry.subject === ask.subject);
        if (gate === undefined && !(await deps.exists(ask.subject))) {
            return {
                kind: "refused",
                code: "unknown",
                message: `Nothing here is called "${ask.subject}": no stored secret and no connected account or connector goes by that name, so there is no one to ask to release it. Check the name against \`secrets gates\` and \`capabilities list\`. If the task needs a secret nobody has stored yet, ask for it with \`secrets ask ${ask.subject}\`; if it needs an account or connector that is not connected, use \`capabilities request <entry>\`.`,
            };
        }
        if (gate === undefined) {
            return {
                kind: "refused",
                code: "not_gated",
                message: `"${ask.subject}" is not behind an approver, so there is nothing to ask for: it is already yours to use. If this turn cannot reach it, its persona may leave it out, which \`grants request capability ${ask.subject}\` asks about; if a tool still refuses it, read that tool's own error rather than asking again.`,
            };
        }
        if (gate.scope === "use") {
            return {
                kind: "refused",
                code: "per_use",
                message: `"${gate.subject}" is released one use at a time, so there is nothing to ask for in advance: write the credential's reference into the command you actually want to run, and the approval card goes up for that one use.`,
            };
        }
        const held = deps.grants().has(context.conversationId, gate.subject);
        if (held !== undefined) {
            return { kind: "met", message: `"${gate.subject}" is already released to this conversation by ${held.approvedBy}. An account mounts from the turn after the release.` };
        }
        const subject: ReleaseNeed = { kind: "release", subject: gate.subject, approvers: [...gate.approvers] };
        return { kind: "raise", subject, title: `Release "${gate.subject}" to this conversation` };
    };

    const subjectOf = (need: Need): ReleaseNeed | undefined => (need.subject.kind === "release" ? need.subject : undefined);

    return {
        resolve,
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            const held = subject === undefined ? undefined : deps.grants().has(need.conversationId, subject.subject);
            return held === undefined || subject === undefined
                ? undefined
                : { result: `"${subject.subject}" is released to this conversation by ${held.approvedBy}.`, use: ["An account or connector mounts from the conversation's next turn."] };
        },
        // Only the people the gate names, by verified address, yes or no: a stranger's click leaves it waiting for them,
        // since letting anyone decline would let anyone cancel somebody else's release.
        mayAnswer: (need, by) => {
            const subject = subjectOf(need);
            const email = by.email?.toLowerCase();
            return subject === undefined || (email !== undefined && subject.approvers.some((approver) => approver.toLowerCase() === email))
                ? undefined
                : `Only ${names(subject.approvers)} can answer this.`;
        },
        answer: async (need, answer, by) => {
            const subject = subjectOf(need);
            const email = by.email?.toLowerCase();
            if (subject === undefined || answer.kind !== "release" || email === undefined) {
                return { refused: "A release is answered by releasing it, or declined." };
            }
            deps.grants().grant(need.conversationId, subject.subject, { approvedBy: email, at: now() });
            return {
                status: "met",
                result: `"${subject.subject}" is released to this conversation by ${email}.`,
                use: ["It mounts from the conversation's next turn: finish what you can now, and the sandbox continues the conversation with it."],
            };
        },
        nextTurn: () => true,
        key: (subject: NeedSubject) => (subject.kind === "release" ? subject.subject : ""),
    };
};
