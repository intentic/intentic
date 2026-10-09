import { computed, watch } from "vue";
import type { LandedMessageDraft } from "@intentic/sandbox-contract";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useNotifications } from "../../../../workbench/notifications/notifications";
import { commitMessageOf } from "../changeOrigins";
import { fillCommitMessage, namedAfter } from "./commitMessage";
import { t } from "@intentic/ui/i18n";

// Watches every landing's drafted commit message from module scope, not from ReviewPanel (which is destroyed
// by the Files|Changes|History switch), so a start, an arrival or a failure is announced wherever the user is
// standing. Drafting begins the instant work lands (daemon's agents/landed-subject.ts).

/** Where one agent's commit-message draft stands in a roster frame: none, under way, or ended one way or the other. */
export type DraftPhase = "none" | "running" | "written" | "failed";

export const draftPhase = (draft: LandedMessageDraft | undefined): DraftPhase => (draft === undefined ? `none` : (draft.outcome ?? `running`));

/** A change worth a receipt, between two frames of the roster. */
export interface DraftReceipt {
    readonly id: string;
    readonly kind: "started" | "written" | "failed";
}

/**
 * Only transitions this window watched on an agent it already knew. A draft present in the first frame of a roster (a
 * reload painting a saved copy, a reconnect re-reading the fleet) is not one that just started. A draft that vanished
 * with no outcome is one the daemon withdrew (nothing left to describe) or forgot (it restarted, which also killed the
 * drafting): neither is a failure to report, and the commit box is still there to name the commit by hand.
 */
export const draftReceipts = (before: ReadonlyMap<string, DraftPhase>, after: ReadonlyMap<string, DraftPhase>): readonly DraftReceipt[] =>
    [...after].flatMap(([id, phase]): DraftReceipt[] => {
        const was = before.get(id);
        if (was === undefined || was === phase) {
            return [];
        }
        if (phase === `running`) {
            return [{ id, kind: `started` }];
        }
        return was === `running` && phase !== `none` ? [{ id, kind: phase }] : [];
    });

// Each agent's draft phase, as a fresh map per roster frame, so the watcher's old value is the frame before.
const phases = computed<ReadonlyMap<string, DraftPhase>>(
    () => new Map(useAgents().fleet.value.map((agent) => [agent.id, draftPhase(agent.landedMessageDraft)])),
);

// Landed message for the named-after session, from the roster only; archived agents are filled by ReviewPanel instead.
const askedFor = computed(() =>
    namedAfter.value === undefined ? undefined : useAgents().fleet.value.find((agent) => agent.id === namedAfter.value)?.landedMessage,
);

const titleOf = (id: string): string => useAgents().fleet.value.find((agent) => agent.id === id)?.title ?? t(`workspace.draftingReceipts.anAgent`);

// Started once and never stopped; a workspace report belongs to the session, not to whichever component is mounted.
export const startDraftingReceipts = (): void => {
    const { say, warn } = useNotifications();

    watch(phases, (now, was) => {
        // One line per receipt; two agents landing together is uncommon but real.
        for (const receipt of draftReceipts(was, now)) {
            const title = titleOf(receipt.id);
            if (receipt.kind === `started`) {
                say(t(`workspace.draftingReceipts.writingCommitMessage`, { title }));
                continue;
            }
            if (receipt.kind === `written`) {
                say(t(`workspace.draftingReceipts.commitMessageReady`, { title }));
                continue;
            }
            // Names which model refused, or the walk's own reason when it never got that far; the full list is in the
            // panel.
            const report = useAgents().fleet.value.find((agent) => agent.id === receipt.id)?.landedMessageDraft;
            const refused = report?.steps.filter((step) => step.status === `refused`) ?? [];
            const blame =
                refused.length > 0 ? t(`workspace.draftingReceipts.modelsRefused`, { models: refused.map((step) => step.model).join(`, `) }) : report?.reason;
            warn(
                blame === undefined
                    ? t(`workspace.draftingReceipts.couldntWriteCommitMessage`, { title })
                    : t(`workspace.draftingReceipts.couldntWriteCommitMessageBecause`, { title, reason: blame }),
            );
        }
    });

    // Fills the box on arrival (or immediately if already written); silent, since the start above already announced it.
    watch(
        askedFor,
        (message) => {
            const commit = commitMessageOf(message);
            if (commit !== undefined) {
                fillCommitMessage(commit);
            }
        },
        { immediate: true },
    );
};
