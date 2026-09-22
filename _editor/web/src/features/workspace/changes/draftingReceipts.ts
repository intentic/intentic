import { computed, watch } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { useNotifications } from "../../../shell/notifications/notifications";
import { commitMessageOf, draftRunning } from "./changeOrigins";
import { fillCommitMessage, namedAfter } from "./commitMessage";
import { t } from "@intentic/ui/i18n";

// Watches every landing's drafted commit message from module scope, not from ReviewPanel (which is destroyed
// by the Files|Changes|History switch), so a start, an arrival or a failure is announced wherever the user is
// standing. Drafting begins the instant work lands (daemon's agents/landed-subject.ts).

// Agents with a draft in progress, read off the broadcast fleet roster rather than a workspace rescan.
const drafting = computed(() => useAgents().fleet.value.filter((agent) => draftRunning(agent.landedMessageDraft)));

// Landed message for the named-after session, from the roster only; archived agents are filled by ReviewPanel instead.
const askedFor = computed(() =>
    namedAfter.value === undefined ? undefined : useAgents().fleet.value.find((agent) => agent.id === namedAfter.value)?.landedMessage,
);

const titleOf = (id: string): string => useAgents().fleet.value.find((agent) => agent.id === id)?.title ?? t(`workspace.draftingReceipts.anAgent`);

// Started once and never stopped; a workspace report belongs to the session, not to whichever component is mounted.
export const startDraftingReceipts = (): void => {
    const { say } = useNotifications();

    watch(drafting, (now, was) => {
        const started = now.filter((agent) => !was.some((before) => before.id === agent.id));
        // One line per newly-started draft; two agents landing together is uncommon but real.
        for (const agent of started) {
            say(t(`workspace.draftingReceipts.writingCommitMessage`, { title: agent.title ?? t(`workspace.draftingReceipts.anAgent`) }));
        }

        // Every ended draft gets a line either way: a written sentence, or the reason it couldn't be.
        for (const agent of was.filter((before) => !now.some((current) => current.id === before.id))) {
            // Reads the roster's current frame, not the stale `was`, which by construction predates the answer.
            const current = useAgents().fleet.value.find((entry) => entry.id === agent.id);
            if (current?.landedMessage !== undefined && current.landedMessageDraft?.outcome === `written`) {
                say(t(`workspace.draftingReceipts.commitMessageReady`, { title: titleOf(agent.id) }));
                continue;
            }
            // Names which model refused, or the walk's own reason when it never got that far; the full list is in the
            // panel.
            const report = current?.landedMessageDraft;
            const refused = report?.steps.filter((step) => step.status === `refused`) ?? [];
            const blame =
                refused.length > 0 ? t(`workspace.draftingReceipts.modelsRefused`, { models: refused.map((step) => step.model).join(`, `) }) : report?.reason;
            say(
                blame === undefined
                    ? t(`workspace.draftingReceipts.couldntWriteCommitMessage`, { title: titleOf(agent.id) })
                    : t(`workspace.draftingReceipts.couldntWriteCommitMessageBecause`, { title: titleOf(agent.id), reason: blame }),
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
