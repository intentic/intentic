import type { Automation, AutomationFirstCheck, AutomationNeed, Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// An automation an agent proposes (docs/architecture/needs.md): "tell me when Bun 1.4.3 ships", "pick this back up when
// the release lands". Work that runs unattended spends an allowance and acts while nobody watches, so an agent never
// saves one itself: the card shows exactly what would be saved, with what its check sees today, and a person's
// approval is what saves it, held to the same rules the Automations page saves by.

export interface AutomationNeedDeps {
    // Throws the refusal the Automations page would show, as a BAD_REQUEST; resolves when it could be saved as it is.
    readonly refuse: (automation: Automation) => Promise<void>;
    readonly save: (automation: Automation) => Promise<void>;
    readonly exists: (id: string) => Promise<boolean>;
    // A ready-made source checked once, for the card; undefined for a guard command, which is never run before approval.
    readonly firstCheck: (automation: Automation) => Promise<AutomationFirstCheck | undefined>;
}

// The placeholder the CLI sends for "the conversation asking": resolved here, from the raising turn, rather than trusted
// from the shell's environment.
export const HERE = "here";

const refusalOf = (error: unknown): string | undefined => (error instanceof ORPCError && error.code === "BAD_REQUEST" ? error.message : undefined);

// The proposal as it would be saved: switched on, and a conversation target of "here" named.
const proposed = (automation: Automation, context: AskContext): Automation => {
    const target =
        automation.target?.kind === "conversation" && automation.target.conversationId === HERE
            ? { kind: "conversation" as const, conversationId: context.conversationId }
            : automation.target;
    return { ...automation, enabled: true, ...(target === undefined ? {} : { target }) };
};

const titleOf = (automation: Automation, replaces: boolean): string => {
    const what = automation.note ?? automation.id;
    return replaces ? `Replace the automation ${automation.id}: ${what}` : `Run an automation unattended: ${what}`;
};

export const automationNeed = (deps: AutomationNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): AutomationNeed | undefined => (need.subject.kind === "automation" ? need.subject : undefined);

    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "automation") {
            return { kind: "refused", code: "invalid", message: "Not an automation ask." };
        }
        const automation = proposed(ask.automation, context);
        try {
            await deps.refuse(automation);
        } catch (error) {
            const refusal = refusalOf(error);
            if (refusal === undefined) {
                throw error;
            }
            return { kind: "refused", code: "invalid_automation", message: `Nothing was proposed: ${refusal}. Fix that and propose it again.` };
        }
        const replaces = await deps.exists(automation.id);
        const firstCheck = await deps.firstCheck(automation);
        const subject: AutomationNeed = {
            kind: "automation",
            automation,
            ...(replaces ? { replaces } : {}),
            ...(firstCheck === undefined ? {} : { firstCheck }),
        };
        return { kind: "raise", subject, title: titleOf(automation, replaces) };
    };

    return {
        resolve,
        // Met only by a person's approval; nothing else can save it.
        check: async (): Promise<Met | undefined> => undefined,
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "An automation proposal is answered by approving it, or declined." };
            }
            try {
                // Checked again: the world moved since it was proposed (a conversation archived, a moment passed).
                await deps.refuse(subject.automation);
                await deps.save(subject.automation);
            } catch (error) {
                const refusal = refusalOf(error);
                if (refusal === undefined) {
                    throw error;
                }
                return { refused: `It cannot be saved as proposed: ${refusal}.` };
            }
            return {
                status: "met",
                result: `The automation ${subject.automation.id} is saved and switched on.`,
                use: [
                    `\`automations show ${subject.automation.id}\` says what its check saw last and when it next runs.`,
                    "Do not watch for the same thing yourself as well: it runs whether or not this conversation does.",
                ],
            };
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "automation" ? subject.automation.id : ""),
    };
};
