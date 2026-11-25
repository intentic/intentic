<script setup lang="ts">
import { Button, toneTint } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { computed, ref, useId } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import { noticeFailure } from "../../../../models/conversations/transcript/sandboxNotice";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import NoticeDetails from "./NoticeDetails.vue";
import { noticeActionOf } from "./noticeActions";
import NoticeMark from "./NoticeMark.vue";
import { noticePartsOf } from "./noticeParts";

/* THE FAILURE A TURN ENDED ON, with nothing run after it (noticeLayout.ts `strip`): a tinted strip, never one more grey
   line to scroll past. Its sentence in full, the provider's or the sandbox's own words and every attempt one press away
   in place, and its one fix (send again, another model) as the bright button. A wall the composer's own card answers
   (the access wall, the ways out) keeps its presses there, and the strip only says what happened. */

const props = defineProps<{
    message: ChatMessage;
    incident?: ChatIncident | undefined;
}>();

const t = useT();
const { conversation } = usePaneView();
const { audience } = useAudience();
const parts = computed(() => noticePartsOf(props.message, audience.value, { home: isHomeConversationId(conversation.value.conversationId) }));
const action = computed(() => noticeActionOf(props.message));
const said = computed(() => noticeFailure(props.message)?.said);
const behind = computed(() => said.value !== undefined || props.incident !== undefined);
const time = computed(() => (props.message.openedAt === undefined ? undefined : formatClock(props.message.openedAt)));
const open = ref(false);
const detailsId = useId();
</script>

<template>
    <div class="flex w-full flex-col gap-1.5 rounded-lg border px-3.5 py-2" :class="toneTint(parts.tone, `soft`)" role="status" data-notice-strip>
        <div class="flex min-w-0 items-start gap-2 text-xs">
            <span class="chat-mark"><NoticeMark :tone="parts.tone" :icon="parts.icon" /></span>
            <p class="min-w-0 flex-1 leading-relaxed break-words text-content" data-notice-words>{{ parts.subject }}</p>
            <span v-if="time" class="shrink-0 text-2xs leading-relaxed text-subtle tabular-nums">{{ time }}</span>
        </div>
        <div v-if="behind || action" class="flex flex-wrap items-center justify-end gap-1">
            <Button v-if="behind" size="small" tier="quiet" :aria-expanded="open" :aria-controls="detailsId" @click="open = !open">
                {{ t(`chat.noticeStrip.details`) }}
                <Icon name="chevron-down" class="text-2xs transition" :class="open && `rotate-180`" aria-hidden="true" />
            </Button>
            <component :is="action" v-if="action" :message="message" tier="accent" />
        </div>
        <div v-if="open" :id="detailsId" class="pb-1 pl-[var(--chat-hang,1.375rem)]">
            <NoticeDetails :said="said" :incident="incident" />
        </div>
    </div>
</template>
