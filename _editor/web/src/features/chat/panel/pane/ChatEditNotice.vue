<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { usePaneView } from "../useChat-view";

/* An armed edit, said over the composer: which message it replaces and what goes with it, and the two ways out of it. */

const t = useT();
const view = usePaneView();
const { conversation, editing, draft, attachments, messages } = view;

// How many bubbles the send replaces, the same set the turns strike through.
const dropped = computed(() => conversation.value.transcript.doomed.value.size);

// Forks "now" at the edited prompt, taking the half-written replacement along; this pane gets back what the pencil displaced.
const keepBoth = (): void => {
    const target = editing.value;
    const cut = target === undefined ? -1 : messages.value.indexOf(target);
    if (cut < 0) {
        return;
    }
    const carried = draft.value;
    const chips = attachments.value;
    conversation.value.transcript.cancelEdit();
    const fork = view.forkAt(cut, `now`);
    if (fork !== undefined) {
        fork.draft.value = carried;
        fork.attachments.value = [...chips];
    }
};
</script>

<template>
    <div
        v-if="editing !== undefined"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-primary-500/40 bg-primary-600/10 px-3 py-2 text-2xs text-muted"
    >
        <Icon name="pencil" class="shrink-0 text-link" />
        <span class="min-w-0 flex-1">
            {{ t(`chat.chatPane.editingMessage`) }}
            <template v-if="dropped > 1">{{ t(`chat.chatPane.belowReplacedSend`, { editDropped: dropped - 1 }) }}</template>
            <template v-else>{{ t(`chat.chatPane.replacedSend`) }}</template>
        </span>
        <!-- The keep-answer action precedes Cancel so the answer is read first. -->
        <Button size="small" severity="secondary" :text="true" class="shrink-0" v-tooltip.top="t(`chat.chatPane.openNewChatHere`)" @click="keepBoth">
            {{ t(`chat.chatPane.keepBothInstead`) }}
        </Button>
        <Button
            size="small"
            :text="true"
            class="shrink-0"
            v-tooltip.top="t(`chat.chatPane.leaveEverythingNothingChanged`)"
            @click="conversation.transcript.cancelEdit()"
        >
            {{ t(`ui.action.cancel`) }}
        </Button>
    </div>
</template>
