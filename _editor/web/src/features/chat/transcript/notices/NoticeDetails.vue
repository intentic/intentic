<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import NoticeFailureDetails from "./NoticeFailureDetails.vue";

/* What a notice keeps behind its one line, opened by a press: the provider's or the harness's own words (a failure, or
   the refusal a move was made for), or, for a row standing for a whole incident (chatIncidents.ts), every refused
   attempt with when it was refused and in what words. The press names how many attempts there were, so the count is
   read without opening it. A sentence the attempt before already said is not printed twice. */

const props = defineProps<{ said?: string | undefined; incident?: ChatIncident | undefined }>();

const t = useT();
const open = ref(false);

const attempts = computed(() =>
    (props.incident?.attempts ?? []).map((attempt, index, all) => ({
        key: index,
        at: attempt.at === undefined ? undefined : formatClock(attempt.at),
        words: index > 0 && all[index - 1]!.said === attempt.said ? undefined : attempt.said,
    })),
);
// Every attempt as it was said, for a bug report or a support ticket: the repeats too, each with its moment.
const copied = computed(() =>
    (props.incident?.attempts ?? []).map((attempt) => (attempt.at === undefined ? attempt.said : `${formatClock(attempt.at)} ${attempt.said}`)).join(`\n`),
);
const label = computed(() => {
    const count = props.incident?.attempts.length;
    if (count !== undefined) {
        return open.value ? t(`chat.incident.hideAttempts`) : t(`chat.incident.attempts`, { count }, count);
    }
    return open.value ? t(`chat.failure.hideDetails`) : t(`chat.failure.details`);
});
</script>

<template>
    <template v-if="incident !== undefined || said !== undefined">
        <button type="button" class="touch-target shrink-0 font-medium text-link hover:underline" :aria-expanded="open" @click="open = !open">
            {{ label }}
        </button>
        <div v-if="open && incident !== undefined" class="chat-inset flex w-full flex-col gap-2 px-3 py-2 text-left text-2xs leading-relaxed" data-incident-attempts>
            <ol class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
                <li v-for="attempt in attempts" :key="attempt.key" class="contents">
                    <span class="text-subtle tabular-nums">{{ attempt.at ?? `` }}</span>
                    <span class="break-words whitespace-pre-line text-content select-text">{{ attempt.words ?? t(`chat.incident.same`) }}</span>
                </li>
            </ol>
            <CopyButton :text="copied" :label="t(`chat.failure.copyDetails`)" class="ml-auto" />
        </div>
        <NoticeFailureDetails v-else-if="open && said !== undefined" :said="said" />
    </template>
</template>
