import { childReportPrompt, type ChildReportFields } from "@intentic/sandbox-contract/events/agent-words";
import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
import { parentOfActor } from "../../auth/principal.js";
import { deliverWake, type WakeDoors } from "../../seams/wake-delivery.js";
import { bookedRerunWords } from "../../conversations/land/child-lands.js";
import { childVerification } from "./child-verification.js";
import { familyEnded } from "./family-cancel.js";
import { subagentEndingReported, subagentEndingReporter } from "./subagents.js";
import { noteQueuedReport, queuedChildReportId } from "./waiting/queued-reports.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import type { ConversationActors, ConversationObserver } from "../../conversations/actor/conversation-actors.js";
import type { ConversationState } from "../../conversations/actor/conversation-state.js";
import { expectTurn } from "../../conversations/actor/conversation-holdings.js";

// A child's settled turn reaches its parent one way: a parked `wait` took it, or it is delivered like any wake, queued
// behind a parent busy with a turn that cannot take it.

export interface ChildReportDeps {
    readonly doors: WakeDoors;
    readonly logger: Logger;
    // Where the child's roster record, its verification ledger and a report still queued for its parent are held, and
    // where a report on its way marks its parent (owedReports).
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
    // A child's entry names its parent in `startedBy`; `fresh` marks a person's session on that parent's work, which
    // never reports to it.
    readonly entryOf: (
        conversationId: string,
    ) => { readonly startedBy?: string | undefined; readonly title?: string | undefined; readonly fresh?: boolean | undefined } | undefined;
    // What the parent runs as now, which the report's turn continues.
    readonly profileOf: (conversationId: string) => TurnProfile | undefined;
    // The ending a parent reads for a child whose runtime was killed under it; undefined for a failure of its own.
    readonly killNote: (childId: string, failure: string) => Promise<string | undefined>;
    // Where the child's work went, in the parent's words (child-lands.ts childLandingWords).
    readonly landingOf: (childId: string) => string | undefined;
    // The runner the child's turn ran on, undefined for this sandbox (agents-store.ts worktreeOf).
    readonly machineOf?: (childId: string) => string | undefined;
    // Whether the child is moving itself onto a fallback (children.ts childMovingOn): the move says its own words.
    readonly movingOn?: (childId: string) => boolean;
    // For a child spawned with a result schema, what the turn that ended with this closing message handed back
    // (children.ts childTurnResult); undefined for one spawned without.
    readonly resultOf?: (childId: string, closing: string) => ChildReportFields["result"];
    // Whether the child is a workflow run's worker (children.ts isWorker), whose endings its run reads instead.
    readonly worker?: (childId: string) => boolean;
    // The mark each report on its way holds on its parent, given back as the report goes (owedReports).
    readonly owed?: Pick<OwedReports, "given">;
}

// Characters of the child's answer a report carries, from the head where the answer is; the rest stays in its chat.
const REPORT_CHARS = 4_000;

const reportText = (settled: DomainEventMap["run.settled"], killed: string | undefined): string => {
    const answer =
        settled.closing.length <= REPORT_CHARS
            ? settled.closing
            : `${settled.closing.slice(0, REPORT_CHARS)}… (cut here: wait(target: "${settled.conversationId}") returns its whole report)`;
    const ending = killed ?? (settled.failure === undefined ? undefined : `The turn failed: ${settled.failure}`);
    // A re-run the sandbox booked for itself leads, ahead of the failure, or the parent sends the task again or hands it
    // on before it reads that far.
    const rerun =
        settled.rerun === undefined || killed !== undefined
            ? undefined
            : `Paused, not finished. ${bookedRerunWords(settled.rerun, settled.conversationId)}`;
    return [...(rerun === undefined ? [] : [rerun]), answer, ...(ending === undefined ? [] : [ending])].filter((part) => part !== "").join("\n\n");
};

// The parent a child's turn reports to, by who the child is and who asked for the turn: nobody when a person started it
// in the child's own chat, the child moves itself onto a fallback or is a workflow's worker, or the parent is gone; nor
// ever for a fresh session (a review or test a person opened on the parent's work), whose findings reach the parent
// only when that person sends them, so a re-run the sandbox fires itself wakes nobody either.
const reportsTo = (deps: ChildReportDeps, childId: string, actor: string | undefined): string | undefined => {
    const entry = deps.entryOf(childId);
    const parent = parentOfActor(entry?.startedBy);
    if (
        parent === undefined ||
        entry?.fresh === true ||
        (actor !== undefined && parentOfActor(actor) !== parent) ||
        deps.movingOn?.(childId) === true ||
        deps.worker?.(childId) === true
    ) {
        return undefined;
    }
    return deps.entryOf(parent) === undefined ? undefined : parent;
};

// The same, and nobody either once a wait already took the ending.
const parentToTell = (
    deps: ChildReportDeps,
    settled: DomainEventMap["run.settled"],
): { readonly parent: string; readonly profile: TurnProfile; readonly title: string | undefined } | undefined => {
    const parent = reportsTo(deps, settled.conversationId, settled.actor);
    if (parent === undefined || subagentEndingReported(deps.conversations, settled.conversationId)) {
        return undefined;
    }
    const profile = deps.profileOf(parent);
    return profile === undefined ? undefined : { parent, profile, title: deps.entryOf(settled.conversationId)?.title };
};

const owedKey = (child: string, run: string): string => `${child}\u0000${run}`;

/** A child's report on its way, marked on its parent from the child's settle until the report is said (conversation-holdings.ts). */
export interface OwedReports {
    readonly observer: ConversationObserver;
    // The report about this run of this child went where it went, or nowhere.
    readonly given: (child: string, run: string) => void;
}

/**
 * The child's ending reaches the roster at its settle, and its report reaches the parent only once the run has written
 * its record and `run.settled` has composed and admitted it: for that whole hand-off a parent at rest read as one
 * nothing will wake, and a child's failure or clash beside it as the reader's (agent-lanes.ts callsOwner), its card
 * flying into Attention and back. Told at the settle itself, before its broadcast goes out, so the parent is marked in
 * the very roster that first shows the child's ending.
 */
export const owedReports = (deps: ChildReportDeps): OwedReports => {
    // Who asked for each conversation's turn now running, as its begin was granted (BeginTurn.startedBy), and the
    // release of each report marked on a parent.
    const asked = new Map<string, string | undefined>();
    const owed = new Map<string, () => void>();
    const settled = (conversationId: string, before: ConversationState): void => {
        const actor = asked.get(conversationId);
        asked.delete(conversationId);
        const run = before.journal?.run;
        const parent = run === undefined ? undefined : reportsTo(deps, conversationId, actor);
        if (run !== undefined && parent !== undefined && !familyEnded(deps.conversations, parent, Date.now())) {
            owed.set(owedKey(conversationId, run), expectTurn(deps.conversations, parent, "child-report", conversationId));
        }
    };
    return {
        observer: (conversationId, event, before, after) => {
            if (event.kind === "begin" && before.phase.kind !== "running" && after.phase.kind === "running") {
                asked.set(conversationId, event.turn.startedBy);
            } else if (event.kind === "settle" && before.phase.kind === "running") {
                settled(conversationId, before);
            }
        },
        given: (child, run) => {
            const key = owedKey(child, run);
            owed.get(key)?.();
            owed.delete(key);
        },
    };
};

/** Never throws: it runs off a turn's ending. */
export const reportChildTurn = async (deps: ChildReportDeps, settled: DomainEventMap["run.settled"]): Promise<void> => {
    try {
        const target = parentToTell(deps, settled);
        if (target === undefined) {
            return;
        }
        // Stopped because a conversation above its parent left the board: said to the parent, it would only wake it into a
        // turn of its own (family-cancel.ts).
        if (familyEnded(deps.conversations, target.parent, Date.now())) {
            deps.logger.info(
                { child: settled.conversationId, parent: target.parent },
                "child report: its family was just cancelled, it stays in the child's own chat",
            );
            return;
        }
        // Taken before anything is awaited: the record this ending is about, whichever arrives first of it and this.
        const reported = subagentEndingReporter(deps.conversations, settled.conversationId);
        const prompt = childReportPrompt({
            child: settled.conversationId,
            title: target.title,
            failed: settled.failure !== undefined,
            stopped: settled.stopped === true,
            report: reportText(settled, settled.failure === undefined ? undefined : await deps.killNote(settled.conversationId, settled.failure)),
            verification: childVerification(deps.conversations, settled.conversationId),
            landing: deps.landingOf(settled.conversationId),
            machine: deps.machineOf?.(settled.conversationId),
            // A turn that failed or was stopped hands nothing back, which its ending already says.
            result: settled.failure === undefined && settled.stopped !== true ? deps.resultOf?.(settled.conversationId, settled.closing) : undefined,
        });
        // Asked again after the awaits above: a wait of the parent's may have taken this ending meanwhile.
        if (subagentEndingReported(deps.conversations, settled.conversationId)) {
            return;
        }
        const messageId = queuedChildReportId(settled.conversationId);
        const receipt = await deliverWake(deps.doors, {
            conversationId: target.parent,
            prompt,
            voice: "sandbox",
            profile: target.profile,
            messageId,
        });
        if ("invalid" in receipt) {
            deps.logger.error(
                { child: settled.conversationId, parent: target.parent, report: prompt, invalid: receipt.invalid },
                "child report: its parent could not take it, it stays in the child's own chat",
            );
            return;
        }
        if ("why" in receipt) {
            deps.logger.info(
                { child: settled.conversationId, parent: target.parent, why: receipt.why },
                "child report: its parent took nothing, it stays in the child's own chat",
            );
            return;
        }
        // Said into its turn, or a turn of its own: the parent has it, and `wait` must not hand it over again. One still
        // queued behind a turn that takes no words is not read yet, so a wait meanwhile may still return it, and then
        // takes it out of the queue (queued-reports.ts) rather than letting it arrive a second time.
        if (receipt.delivered === "queued") {
            noteQueuedReport(deps.conversations, settled.conversationId, { parent: target.parent, messageId });
        } else {
            reported();
        }
        deps.logger.info({ child: settled.conversationId, parent: target.parent, delivered: receipt.delivered }, "child report: delivered");
    } catch (error) {
        deps.logger.warn({ err: error, child: settled.conversationId }, "child report: could not be delivered");
    } finally {
        // Said, queued or started (whose run holds a mark of its own until it begins), or going nowhere.
        deps.owed?.given(settled.conversationId, settled.run);
    }
};
