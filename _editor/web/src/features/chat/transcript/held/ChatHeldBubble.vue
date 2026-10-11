<script setup lang="ts">
import type { QueuedMessage } from "@intentic/sandbox-contract";
import { Icon, type TooltipValue, useDevice } from "@intentic/ui";
import { formatClock, formatDateTime } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed, ref, useTemplateRef, watch } from "vue";
import ChatAttachmentStrip from "../../composer/ChatAttachmentStrip.vue";
import { attachmentPreview } from "../../drafts/attachmentPreviews";
import { usePaneView } from "../../panel/useChat-view";
import ChatImageThumb from "../attachments/ChatImageThumb.vue";

/* One message that did not go out, drawn as the prompt it would have been (its words, its pictures) with an edge that says it was not sent, and its one door: a person's words go back into the composer to be edited there (and sent, or booked, again), anyone else's are removed. */

const props = defineProps<{
    message: QueuedMessage;
    // One line and small pictures: the composer's own row (the quick bar), where no transcript stands above it.
    compact?: boolean;
}>();

const t = useT();
const { unqueue } = usePaneView();
const { mobile } = useDevice();

// Who it is from when a person did not type it; a person's own reads as theirs, like any prompt.
const from = computed(() => {
    if (props.message.voice === `person`) {
        return undefined;
    }
    return props.message.voice === `agent` ? t(`chat.chatQueue.fromAgent`) : t(`chat.chatQueue.fromSandbox`);
});

// Resolved the way a sent prompt's are (ChatMessageView), so the picture that went with it is the picture drawn here.
const attachments = computed(() => (props.message.attachments ?? []).map((path) => ({ name: basename(path), path, previewUrl: attachmentPreview(path) })));
const pictures = computed(() => attachments.value.filter((entry) => entry.previewUrl !== undefined));
const files = computed(() => attachments.value.filter((entry) => entry.previewUrl === undefined));
// One picture sits beside the words once the pane is wide enough, as it does on a sent prompt.
const aside = computed(() => props.message.text.length > 0 && attachments.value.length === 1 && pictures.value.length === 1);

// The clamp is the sent prompt's (.chat-prompt-text); whether it cut anything is measured, since it depends on the wrap width.
const bubble = useTemplateRef<HTMLElement>(`bubble`);
const overflowing = ref(false);
const expanded = ref(false);
watch(
    bubble,
    (element, _previous, onCleanup) => {
        if (element === null) {
            overflowing.value = false;
            return;
        }
        const observer = new ResizeObserver(() => {
            if (!expanded.value) {
                overflowing.value = element.scrollHeight > element.clientHeight + 1;
            }
        });
        observer.observe(element);
        onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: `post` },
);

// Editing happens where words are written: the press takes the message out of the queue and into the composer, its
// files and its booking with it (TurnClient.takenBack), so the box the reader already knows is the editor. A second,
// smaller one here was the poorer copy of it. The sandbox's or an agent's words were nobody's here to write: removed.
const own = computed(() => props.message.voice === `person`);
const doorTip = computed((): TooltipValue =>
    own.value ? { title: t(`chat.chatQueue.edit`), note: t(`chat.chatQueue.editNote`) } : t(`chat.chatQueue.remove`),
);

const queuedClock = computed(() => formatClock(props.message.queuedAt));
const queuedExact = computed(() => formatDateTime(props.message.queuedAt));
</script>

<template>
    <!-- In the quick bar's row everything is in line, the door included, since no gutter stands beside a composer. -->
    <div class="group relative flex gap-1.5" :class="compact ? `w-full items-center` : `max-w-[85%] flex-col items-end`">
        <span v-if="from" class="text-2xs text-subtle">{{ from }}</span>
        <!-- Stacked above the words when they cannot sit beside them. -->
        <ChatAttachmentStrip
            v-if="!compact && attachments.length > 0"
            :attachments="attachments"
            class="flex-wrap justify-end"
            :class="aside && '@lg:hidden'"
        />
        <!-- The quick bar's row keeps the pictures small and in line with the words. -->
        <div class="flex max-w-full min-w-0 items-center gap-1.5" :class="compact && `flex-1`">
            <ChatAttachmentStrip v-if="!compact && aside" :attachments="attachments" class="mr-1 hidden shrink-0 self-start @lg:flex" />
            <template v-if="compact">
                <ChatImageThumb v-for="picture in pictures" :key="picture.path" :src="picture.previewUrl!" :alt="picture.name" size="h-8 w-8" />
                <span v-if="files.length > 0" class="flex min-w-0 items-center gap-1 text-2xs text-subtle">
                    <Icon name="file" class="shrink-0 text-2xs" /><span class="truncate">{{ files.map((file) => file.name).join(`, `) }}</span>
                </span>
            </template>
            <!-- Dashed: the one mark that it never went out; everything else about it is the prompt it would have been. -->
            <div
                v-if="message.text"
                class="chat-surface chat-surface-held relative min-w-0 rounded-lg"
                :class="{ 'flex-1': compact, 'chat-prompt-clamped': overflowing && !expanded, 'chat-prompt-open': expanded }"
            >
                <div
                    ref="bubble"
                    class="chat-prompt-text text-xs leading-relaxed text-muted"
                    :class="[compact ? 'truncate px-2.5 py-1' : 'whitespace-pre-wrap px-3 py-2', { 'cursor-pointer': overflowing && !expanded }]"
                    @click="overflowing && !expanded && (expanded = true)"
                >
                    {{ message.text }}
                </div>
                <button
                    v-if="overflowing && !compact"
                    type="button"
                    class="chat-prompt-toggle touch-target"
                    :aria-expanded="expanded"
                    :aria-label="expanded ? t(`chat.chatMessageView.collapseMessage`) : t(`chat.chatMessageView.expandMessage`)"
                    @click="expanded = !expanded"
                >
                    <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                </button>
            </div>
        </div>
        <!-- When it was sent, in the margin on hover, as on a sent prompt. -->
        <span
            v-if="!compact"
            v-tooltip.top="queuedExact"
            class="absolute inset-y-0 right-full mr-2 flex items-center text-2xs whitespace-nowrap tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100"
            >{{ queuedClock }}</span
        >
        <!-- Its door hangs in the gutter where a sent prompt's pencil does: in reach, and out of the words' way. -->
        <div
            class="flex"
            :class="
                compact
                    ? `shrink-0 items-center`
                    : [
                          `absolute top-0 left-full w-[var(--chat-gutter,1.5rem)] flex-col items-center`,
                          mobile ? `opacity-60` : `opacity-0 group-hover:opacity-100 focus-within:opacity-100`,
                      ]
            "
        >
            <button
                type="button"
                class="flex h-6 cursor-pointer items-center justify-center rounded-md text-subtle hover:bg-overlay hover:text-content max-md:h-9"
                :class="compact ? `w-6 max-md:w-9` : `w-full`"
                v-tooltip.right="doorTip"
                :aria-label="own ? t(`chat.chatQueue.editLabel`) : t(`chat.chatQueue.removeLabel`)"
                @click="unqueue(message)"
            >
                <Icon :name="own ? `pencil` : `times`" class="text-2xs" />
            </button>
        </div>
    </div>
</template>
