import type { IconName, Tip } from "@intentic/ui";
import type { DeliveryConflictReason, LandingDelivery } from "@intentic/sandbox-contract/schemas/project-delivery";
import type { LandedRemover } from "@intentic/sandbox-contract/schemas/agents";
import { t } from "@intentic/ui/i18n";

// What the card says when landed work is no longer in the workspace, in whole or in part. A land arrives as
// uncommitted changes the user can discard like anything else in the Changes panel, which other readings (taken
// between commits) can't see (landed-presence.ts). A qualifier on `landed`, not a status of its own: the lane
// stays Finished since the user already made that decision, and it's orthogonal to the turn lifecycle (a
// since-resumed agent can equally have had its land discarded). Undefined when nothing is missing, which is nearly
// all agents.
// `me` is the reader's address, so their own discard reads as theirs. `offerReland` is whether the card offers Land
// again: not when an agent took the work out, since that was its doing on purpose (an orchestrator tidying away a
// reviewer's patches), and a press that puts it back is the one this line invited from a reader who could not know. The
// card menu keeps it for whoever does.
interface LandedAway {
    readonly text: string;
    readonly hint?: string;
    readonly tip: Tip;
    readonly icon: IconName;
    readonly offerReland: boolean;
}
export const landedAway = (
    agent: { readonly landedPresence?: { readonly landed: number; readonly present: number; readonly removedBy?: LandedRemover } },
    me?: string,
): LandedAway | undefined => {
    const presence = agent.landedPresence;
    if (presence === undefined) {
        return undefined;
    }
    // The hint is a clause, not a paragraph: read as the tail of `text` on one line, carrying only the fact "removed"
    // doesn't say, the branch still has it. The hover's card counts the files: how many are still in the workspace.
    const inWorkspace = { label: t(`agents.agentStatus.inWorkspace`), value: `${presence.present}/${presence.landed}` };
    const by = removedBy(presence.removedBy, me);
    const offerReland = presence.removedBy?.kind !== `agent`;
    // The common shape: the whole of it, one discard, no arithmetic to read.
    if (presence.present === 0) {
        return {
            text: by.line ?? t(`agents.agentStatus.removed`),
            hint: t(`agents.agentStatus.onBranch`),
            tip: {
                title: t(`agents.agentStatus.removedAfterLanding`),
                rows: [inWorkspace],
                note: `${t(`agents.agentStatus.stillOnBranch`)}. ${by.note}`,
            },
            icon: `link-broken`,
            offerReland,
        };
    }
    // A partial discard: the fraction is enough to decide whether enough survived.
    return {
        text: `${presence.present}/${presence.landed}`,
        tip: { title: t(`agents.agentStatus.partlyRemoved`), rows: [inWorkspace], note: `${t(`agents.agentStatus.restOnBranch`)}. ${by.note}` },
        icon: `arrows-h`,
        offerReland,
    };
};

// Who took landed work out, as the card's line (absent where "Removed" alone is all it can say) and the hover's
// sentence. The sandbox names someone only when one party acted on the workspace while the work went; otherwise the
// hover says it could have been either, and that Land again puts back what was taken out on purpose.
interface RemovalWords {
    readonly line?: string;
    readonly note: string;
}
const removedBy = (by: LandedRemover | undefined, me: string | undefined): RemovalWords => {
    if (by === undefined) {
        return { note: t(`agents.agentStatus.removedByWhom`) };
    }
    if (by.kind === `agent`) {
        const who = by.title ?? t(`agents.agentStatus.anotherAgent`);
        return { line: t(`agents.agentStatus.removedBy`, { who }), note: t(`agents.agentStatus.takenOutByAgent`, { who }) };
    }
    if (by.email !== undefined && by.email === me) {
        return { line: t(`agents.agentStatus.removedByYou`), note: t(`agents.agentStatus.takenOutByYou`) };
    }
    const who = by.name ?? by.email;
    return who === undefined
        ? { note: t(`agents.agentStatus.takenOutInChanges`) }
        : { line: t(`agents.agentStatus.removedBy`, { who }), note: t(`agents.agentStatus.takenOutBy`, { who }) };
};

// What a land did in the folder on the owner's computer, for a project folder attached to this computer's own sandbox
// (AgentSummary.delivery): one line under the card's facts. Quiet once the work is there or on its way; warm where the
// owner has something to look at (files kept as they had them) or to do (Bring back, in the folder's window). A land
// into any other folder has no delivery and no line.
interface LandedDelivery {
    readonly text: string;
    readonly tip?: Tip;
    readonly icon: IconName;
    readonly warm: boolean;
}

// How many kept paths the hover names before it counts the rest.
const KEPT_PATHS_NAMED = 6;

const KEPT_REASON = {
    edited: () => t(`agents.agentStatus.keptEdited`),
    link: () => t(`agents.agentStatus.keptLink`),
    outside: () => t(`agents.agentStatus.keptOutside`),
    "missing-git": () => t(`agents.agentStatus.keptNeedsGit`),
} as const satisfies Record<DeliveryConflictReason, () => string>;

// The machine's restore point, as the hover's closing line: what undoes the delivery, for whoever wants it.
const pointNote = (delivery: LandingDelivery): string | undefined =>
    delivery.point === undefined ? undefined : t(`agents.agentStatus.undoPoint`, { point: delivery.point });

// The paths a partial delivery left alone, one row each, with why.
const keptTip = (delivery: LandingDelivery): Tip => {
    const more = delivery.conflicts.length - KEPT_PATHS_NAMED;
    return {
        title: t(`agents.agentStatus.keptAsYouHadThem`),
        rows: delivery.conflicts.slice(0, KEPT_PATHS_NAMED).map(({ path, reason }) => ({ label: path, value: KEPT_REASON[reason]() })),
        note: more > 0 ? t(`agents.agentStatus.keptMore`, { count: more }) : pointNote(delivery),
    };
};

export const landedDelivery = (agent: { readonly delivery?: LandingDelivery }): LandedDelivery | undefined => {
    const delivery = agent.delivery;
    if (delivery === undefined) {
        return undefined;
    }
    const folder = delivery.folder ?? t(`agents.agentStatus.yourFolder`);
    switch (delivery.state) {
        case `delivered`:
            return {
                text: t(`agents.agentStatus.deliveredTo`, { folder }),
                tip: {
                    title: t(`agents.agentStatus.delivered`),
                    rows: [{ label: t(`agents.agentStatus.filesWritten`), value: delivery.applied }],
                    note: pointNote(delivery),
                },
                icon: `folder`,
                warm: false,
            };
        case `partial`: {
            const count = delivery.conflicts.length;
            // "You edited them too" only where that is the whole of why; a link or a missing git says itself in the hover.
            const edited = delivery.conflicts.every(({ reason }) => reason === `edited`);
            return {
                text: edited
                    ? t(`agents.agentStatus.keptOutEdited`, { count, folder }, count)
                    : t(`agents.agentStatus.keptOut`, { count, folder }, count),
                tip: keptTip(delivery),
                icon: `file-edit`,
                warm: true,
            };
        }
        case `waiting`:
            return { text: t(`agents.agentStatus.waitingToDeliver`, { folder }), icon: `clock`, warm: false };
        case `failed`:
            return {
                text:
                    delivery.reason === undefined
                        ? t(`agents.agentStatus.couldntDeliverBare`)
                        : t(`agents.agentStatus.couldntDeliver`, { reason: delivery.reason }),
                icon: `exclamation-circle`,
                warm: true,
            };
        case `too-large`:
            return { text: t(`agents.agentStatus.tooLargeToDeliver`), icon: `exclamation-triangle`, warm: true };
    }
};
