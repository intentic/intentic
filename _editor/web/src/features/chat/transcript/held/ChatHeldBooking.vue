<script setup lang="ts">
import { Button, ResponsiveOverlay, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { agentDisplayTitle } from "../../../../models/agent-status/agentStatus-meta";
import { useAgents } from "../../../../models/fleet/useAgents";
import { openById } from "../../../../models/fleet/useAgents-actions";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import ComposerSendLater from "../../composer/later/ComposerSendLater.vue";
import type { BookedGroup } from "../../../../models/conversations/drafts/bookings";
import { bookingOf, type SendLater } from "../../../../models/conversations/drafts/sendLater";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldRouting from "./ChatHeldRouting.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { QueuedReopen } from "@intentic/sandbox-contract/schemas/agent";
import { accountsOf } from "../../../../models/conversations/accounts/useChat-accounts";

/* Messages booked for later that go together, drawn where the reader looks for what they sent: their own prompts, over one line with the time they go (or the agent they wait for), Change, which re-times them in the panel that booked them, and Send now. Both act on these messages alone: every other booking keeps its own time. */

const props = defineProps<{
    group: BookedGroup;
    // The quick bar's composer: each message on one line (ChatHeldBubble), the line spread across its card.
    compact?: boolean;
}>();

const t = useT();
const { conversation, resumeQueue, spentReopensAt, unqueue, accounts, servingAccount } = usePaneView();
const { agentById } = useAgents();

const until = computed(() => (props.group.booking.kind === `at` ? props.group.booking.at : undefined));
const after = computed(() => (props.group.booking.kind === `after` ? props.group.booking.conversationId : undefined));

// The agent these wait on, by its card's name, and the way to it; undefined title for one no card names.
const awaited = computed(() => {
    const id = after.value;
    if (id === undefined) {
        return undefined;
    }
    const agent = agentById(id);
    return { title: agent === undefined ? undefined : agentDisplayTitle(agent), open: (): void => openById(id) };
});

// Sooner than booked: for a spent allowance, that it may still be spent; for another agent's work, that it goes without
// it; for a time the reader chose, only that it goes now.
const hint = computed((): Tip => {
    if (after.value !== undefined) {
        return { title: t(`chat.chatHeld.sendNowTitle`), note: t(`chat.chatHeld.sendNowAfterNote`) };
    }
    return {
        title: t(`chat.chatHeld.sendNowTitle`),
        note: spentReopensAt.value === undefined ? t(`chat.chatHeld.sendNowTimeNote`) : t(`chat.chatHeld.sendNowSpent`),
    };
});

// The allowance this booking waits out, when it waits one out: what the sandbox recorded with it (`reopenOf`). Never
// read back off the instant, which once took a time somebody chose near a reopen for an allowance's wait; a sandbox too
// old to record the reason says nothing here (docs/architecture/app-plane.md).
const waitedOut = computed((): QueuedReopen | undefined =>
    until.value === undefined ? undefined : props.group.messages.find((message) => message.reopenOf !== undefined)?.reopenOf,
);

// A booking that waits out an allowance nobody needs any more: the account the next turn runs on has room now, because
// the reader switched (or the sandbox moved the chat) to one that has, or the one it waited for reopened early. Said
// under the line with the names, since nothing else on screen ties "sends Wed 00:10" to the account that was spent:
// left alone the message waited out a day for nothing.
type Outgrown = { readonly kind: `moved`; readonly waited: string; readonly serving: string | undefined } | { readonly kind: `reopened`; readonly waited: string };
const outgrown = computed((): Outgrown | undefined => {
    const waited = waitedOut.value;
    if (waited === undefined || spentReopensAt.value !== undefined) {
        return undefined;
    }
    const provider = conversation.value.selection.provider.value;
    const serving = servingAccount.value;
    const label = providerLabel(waited.agent);
    const waitedName = waited.account === undefined ? label : (accountsOf(waited.agent).find((account) => account.id === waited.account)?.label ?? waited.account);
    if (waited.agent === provider && (waited.account === undefined || waited.account === serving)) {
        // Room said only on a reading that shows it: no reading at all is no news that the wait is over.
        return conversation.value.selection.servingState.value?.kind === `ready` ? { kind: `reopened`, waited: waitedName } : undefined;
    }
    const named = (id: string): string => accounts.value.find((account) => account.id === id)?.label ?? id;
    return { kind: `moved`, waited: waitedName, serving: serving === undefined ? undefined : named(serving) };
});
const outgrownWords = computed((): string | undefined => {
    const said = outgrown.value;
    if (said === undefined) {
        return undefined;
    }
    if (said.kind === `reopened`) {
        return t(`chat.chatHeld.bookedForSpentReopened`, { waited: said.waited });
    }
    return said.serving === undefined
        ? t(`chat.chatHeld.bookedForSpentRoomNow`, { waited: said.waited })
        : t(`chat.chatHeld.bookedForSpentRoomOn`, { waited: said.waited, serving: said.serving });
});

// Re-timing these: the panel that booked them, opened over its own press. Offered by a sandbox that can re-time.
const changeAnchor = ref<HTMLElement>();
const changing = ref(false);
const retimable = computed(() => supportsRoute(`agent.queueSchedule`));
const retime = (later: SendLater): void => {
    changing.value = false;
    void conversation.value.turn.reschedule(bookingOf(later), props.group.ids);
};
const sendNow = (): void => {
    changing.value = false;
    void resumeQueue(props.group.ids);
};
// A continuation has no bubble to take back from, so its line carries the press (the words' bubbles carry their own).
const takeBack = (): void => {
    const [message] = props.group.messages;
    if (message !== undefined) {
        void unqueue(message);
    }
};
</script>

<template>
    <!-- A continuation is a Continue booked for later, not words: no bubble, only its line, which says it continues then. -->
    <template v-if="!group.continues">
        <ChatHeldBubble v-for="message in group.messages" :key="message.id" :message="message" :compact="compact" />
    </template>
    <ChatHeldStatus reason="scheduled" :until="until" :after="awaited" :spread="compact" :continues="group.continues">
        <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <span v-if="retimable" ref="changeAnchor" class="inline-flex">
                <Button size="small" thumb tier="quiet" :aria-expanded="changing" @click="changing = !changing">{{
                    t(`chat.chatHeld.change`)
                }}</Button>
            </span>
            <Button v-if="group.continues" size="small" thumb tier="quiet" @click="takeBack()">{{ t(`chat.chatHeld.takeBack`) }}</Button>
            <Button size="small" thumb v-tooltip.top="hint" @click="sendNow()">{{ t(`chat.chatQueue.sendNow`) }}</Button>
        </span>
    </ChatHeldStatus>
    <p v-if="outgrownWords" class="text-2xs text-subtle" :class="compact ? `` : `text-right`" role="note">{{ outgrownWords }}</p>
    <ChatHeldRouting :messages="group.messages" :compact="compact" />
    <ResponsiveOverlay v-model="changing" :anchor="changeAnchor" cross="end" :header="t(`chat.sendLater.reschedule`)" panel-class="w-80 p-1">
        <ComposerSendLater
            :conversation="conversation"
            :picked="group.booking"
            :clear-label="t(`chat.chatQueue.sendNow`)"
            @pick="retime($event)"
            @clear="sendNow()"
        />
    </ResponsiveOverlay>
</template>
