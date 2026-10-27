<!-- What stands where a place the person cannot open would be: a link, a bookmark or a notification led them here, so
     it says what this is, who it is for, and the way forward, rather than sending them elsewhere without a word. -->
<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import type { AccessReason } from "../../client/sandbox/access/accessReason";
import { useAccessRequest } from "../../client/sandbox/access/accessRequest";
import AccessAsk from "./AccessAsk.vue";
import { accessWords } from "../../client/sandbox/access/accessWords";

const {
    reason,
    place,
    size = `page`,
} = defineProps<{
    reason: AccessReason;
    /** The place, as its page or section is titled ("Secrets"). */
    place: string;
    /** `page` for a whole page; `panel` inside a pane or a tab the shell framed. */
    size?: `page` | `panel`;
}>();

const router = useRouter();
const { asked } = useAccessRequest();
const words = computed(() => accessWords(reason, { place, asked: asked.value }));
// Back only when there is somewhere to go back to: a page opened from a link in a new tab has no history of its own.
const canGoBack = computed(() => window.history.length > 1);
</script>

<template>
    <EmptyState icon="lock" :size="size" :title="words.title" :line="words.line" class="flex-1 py-12">
        <template #actions>
            <Button v-if="canGoBack" tier="quiet" :size="size === `panel` ? `small` : undefined" @click="router.back()">{{ t(`ui.action.back`) }}</Button>
            <AccessAsk :reason="reason" :place="place" tier="accent" :small="size === `panel`" />
        </template>
    </EmptyState>
</template>
