import { childReportPrompt, type TurnProfile } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { parentOfActor } from "../../auth/principal.js";
import { deliverWake, type WakeDoors } from "../run/turn/wake-delivery.js";
import { childVerification } from "./child-verification.js";
import { subagentEndingReported } from "./subagents.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import type { ConversationActors } from "../../agents/actor/conversation-actors.js";

// A child's settled turn reaches its parent one way: a parked `wait` took it, or it is delivered like any wake, queued
// behind a parent busy with a turn that cannot take it.

export interface ChildReportDeps {
    readonly doors: WakeDoors;
    readonly logger: Logger;
    // Where the child's roster record and its verification ledger are held.
    readonly conversations: Pick<ConversationActors, "holdings">;
    // A child's entry names its parent in `startedBy`.
    readonly entryOf: (
        conversationId: string,
    ) => { readonly startedBy?: string | undefined; readonly title?: string | undefined; readonly archivedAt?: number | undefined } | undefined;
    // What the parent runs as now, which the report's turn continues.
    readonly profileOf: (conversationId: string) => TurnProfile | undefined;
}

// Characters of the child's answer a report carries, from the head where the answer is; the rest stays in its chat.
const REPORT_CHARS = 4_000;

const reportText = (settled: DomainEventMap["run.settled"]): string => {
    const answer =
        settled.closing.length <= REPORT_CHARS ? settled.closing : `${settled.closing.slice(0, REPORT_CHARS)}… (the rest is in its own chat)`;
    return [answer, ...(settled.failure === undefined ? [] : [`The turn failed: ${settled.failure}`])].filter((part) => part !== "").join("\n\n");
};

// Nobody when a person started the turn in the child's own chat, a wait already took it, or the parent is off the board.
const parentToTell = (
    deps: ChildReportDeps,
    settled: DomainEventMap["run.settled"],
): { readonly parent: string; readonly profile: TurnProfile; readonly title: string | undefined } | undefined => {
    const entry = deps.entryOf(settled.conversationId);
    const parent = parentOfActor(entry?.startedBy);
    if (
        parent === undefined ||
        (settled.actor !== undefined && parentOfActor(settled.actor) !== parent) ||
        subagentEndingReported(deps.conversations, settled.conversationId)
    ) {
        return undefined;
    }
    const parentEntry = deps.entryOf(parent);
    const profile = deps.profileOf(parent);
    return parentEntry === undefined || parentEntry.archivedAt !== undefined || profile === undefined
        ? undefined
        : { parent, profile, title: entry?.title };
};

/** Never throws: it runs off a turn's ending. */
export const reportChildTurn = async (deps: ChildReportDeps, settled: DomainEventMap["run.settled"]): Promise<void> => {
    try {
        const target = parentToTell(deps, settled);
        if (target === undefined) {
            return;
        }
        const prompt = childReportPrompt({
            child: settled.conversationId,
            title: target.title,
            failed: settled.failure !== undefined,
            report: reportText(settled),
            verification: childVerification(deps.conversations, settled.conversationId),
        });
        const receipt = await deliverWake(deps.doors, { conversationId: target.parent, prompt, voice: "sandbox", profile: target.profile });
        if ("invalid" in receipt) {
            deps.logger.error(
                { child: settled.conversationId, parent: target.parent, report: prompt, invalid: receipt.invalid },
                "child report: its parent could not take it, it stays in the child's own chat",
            );
            return;
        }
        deps.logger.info({ child: settled.conversationId, parent: target.parent, delivered: receipt.delivered }, "child report: delivered");
    } catch (error) {
        deps.logger.warn({ err: error, child: settled.conversationId }, "child report: could not be delivered");
    }
};
