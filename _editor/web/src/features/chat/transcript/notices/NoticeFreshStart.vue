<!-- WHERE A HOME CONVERSATION'S MEMORY STARTS OVER (sandbox-notice.ts `freshStart`): drawn across the column as a divider
     rather than as one more line of the log down its edge, since everything above it is still here to read but is no
     longer what the model holds; it goes on from a summary and the latest messages. The sentence under the rule says why,
     in the reader's words (sandboxNotice.ts). -->
<script setup lang="ts">
import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { noticeLine } from "../../../../models/conversations/transcript/sandboxNotice";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

const { message } = defineProps<{ message: ChatMessage }>();

const t = useT();
const { audience } = useAudience();
const line = computed(() => noticeLine(message, audience.value) ?? message.text);
// A history cleared by hand is the one fresh start that left nothing above it.
const cleared = computed(() => {
    const notice = sandboxNoticeOf(message);
    return notice?.code === `freshStart` && notice.params.why === `cleared`;
});
</script>

<template>
    <div class="flex w-full flex-col items-center gap-1 py-2 text-2xs text-subtle" data-fresh-start>
        <div class="flex w-full items-center gap-2">
            <span class="h-px flex-1 bg-line" aria-hidden="true" />
            <span class="inline-flex shrink-0 items-center gap-1 font-medium text-muted">
                <Icon :name="cleared ? `eraser` : `refresh`" class="text-2xs" />{{ t(`chat.noticeFreshStart.label`) }}
            </span>
            <span class="h-px flex-1 bg-line" aria-hidden="true" />
        </div>
        <p class="max-w-prose px-3 text-center text-balance">{{ line }}</p>
    </div>
</template>
