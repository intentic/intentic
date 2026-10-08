<script setup lang="ts">
import type { QueuedMessage } from "@intentic/sandbox-contract";
import { Button, Icon, ui, useDevice } from "@intentic/ui";
import { formatClock, formatDateTime } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed, ref, useTemplateRef, watch } from "vue";
import ChatAttachmentStrip from "../../composer/ChatAttachmentStrip.vue";
import { attachmentPreview } from "../../drafts/attachmentPreviews";
import { usePaneView } from "../../panel/useChat-view";
import ChatImageThumb from "../attachments/ChatImageThumb.vue";

/* One message that did not go out, drawn as the prompt it would have been (its words, its pictures) with an edge that says it was not sent, and its own two doors: reword it, take it back. */

const props = defineProps<{
    message: QueuedMessage;
    // One line and small pictures: the composer's own row (the quick bar), where no transcript stands above it.
    compact?: boolean;
}>();

const t = useT();
const { unqueue, reword } = usePaneView();
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

// The words being given to it, while its reword is open; the queue keeps its place in line.
const rewording = ref<string | undefined>();
// The box takes the caret as it opens, since the press that opened it is a request to type.
const editor = useTemplateRef<HTMLTextAreaElement>(`editor`);
watch(editor, (element) => element?.focus());
const save = async (): Promise<void> => {
    const text = rewording.value?.trim() ?? ``;
    if (text.length === 0 || (await reword(props.message, text))) {
        rewording.value = undefined;
    }
};

const queuedClock = computed(() => formatClock(props.message.queuedAt));
const queuedExact = computed(() => formatDateTime(props.message.queuedAt));
</script>

<template>
    <!-- In the quick bar's row everything is in line, the doors included, since no gutter stands beside a composer. -->
    <div
        class="group relative flex gap-1.5"
        :class="[compact ? `w-full items-center` : `max-w-[85%] flex-col items-end`, { 'w-full': rewording !== undefined }]"
    >
        <span v-if="from" class="text-2xs text-subtle">{{ from }}</span>
        <!-- Stacked above the words when they cannot sit beside them, and while they are being reworded, which keeps the files. -->
        <ChatAttachmentStrip
            v-if="!compact && attachments.length > 0"
            :attachments="attachments"
            class="flex-wrap justify-end"
            :class="aside && rewording === undefined && '@lg:hidden'"
        />
        <form v-if="rewording !== undefined" class="flex w-full flex-col gap-1" @submit.prevent="save">
            <textarea
                ref="editor"
                v-model="rewording"
                rows="3"
                :class="ui.input({ size: `sm` }, 'w-full resize-y')"
                :aria-label="t(`chat.chatQueue.rewordLabel`)"
                @keydown.esc.prevent="rewording = undefined"
            />
            <div class="flex justify-end gap-1">
                <Button size="small" tier="quiet" tone="accent" @click="rewording = undefined">{{ t(`ui.action.cancel`) }}</Button>
                <Button size="small" type="submit">{{ t(`chat.chatQueue.save`) }}</Button>
            </div>
        </form>
        <template v-else>
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
                        class="chat-prompt-toggle"
                        :aria-expanded="expanded"
                        :aria-label="expanded ? t(`chat.chatMessageView.collapseMessage`) : t(`chat.chatMessageView.expandMessage`)"
                        @click="expanded = !expanded"
                    >
                        <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    </button>
                </div>
            </div>
        </template>
        <!-- When it was sent, in the margin on hover, as on a sent prompt. -->
        <span
            v-if="!compact"
            v-tooltip.top="queuedExact"
            class="absolute inset-y-0 right-full mr-2 flex items-center text-2xs whitespace-nowrap tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100"
            >{{ queuedClock }}</span
        >
        <!-- Its doors hang in the gutter where a sent prompt's pencil does: in reach, and out of the words' way. -->
        <div
            v-if="rewording === undefined"
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
                v-if="message.voice === `person`"
                type="button"
                class="flex h-6 cursor-pointer items-center justify-center rounded-md text-subtle hover:bg-overlay hover:text-content"
                :class="compact ? `w-6` : `w-full`"
                v-tooltip.right="t(`chat.chatQueue.reword`)"
                :aria-label="t(`chat.chatQueue.rewordLabel`)"
                @click="rewording = message.text"
            >
                <Icon name="pencil" class="text-2xs" />
            </button>
            <button
                type="button"
                class="flex h-6 cursor-pointer items-center justify-center rounded-md text-subtle hover:bg-overlay hover:text-content"
                :class="compact ? `w-6` : `w-full`"
                v-tooltip.right="t(`chat.chatQueue.takeBack`)"
                :aria-label="t(`chat.chatQueue.removeLabel`)"
                @click="unqueue(message)"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>
    </div>
</template>
