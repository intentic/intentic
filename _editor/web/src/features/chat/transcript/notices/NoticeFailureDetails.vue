<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type FailureFactKey, type FailureRun, failureDetails } from "../../../../models/conversations/transcript/failureDetails";

// What a failure said, inside the card its row raises (NoticeCard.vue): the provider's or the sandbox's words quoted,
// a sentence to a line so a paragraph reads as steps rather than a block, its links live; the ids a support request asks
// for, each with its own copy; and the help article it pointed to.

const { said } = defineProps<{ said: string }>();

const t = useT();
const details = computed(() => failureDetails(said));

// A new line after each sentence that ends inside a run of words, so a paragraph of five sentences is five short lines.
const SENTENCE_END = /([.!?])\s+(?=[A-Z“"(])/g;
const prose = computed<FailureRun[]>(() => details.value.prose.map((run) => (`url` in run ? run : { text: run.text.replace(SENTENCE_END, `$1\n`) })));

const FACT_LABELS = {
    category: () => t(`chat.failure.category`),
    request: () => t(`chat.failure.requestId`),
    message: () => t(`chat.failure.messageId`),
} as const satisfies Readonly<Record<FailureFactKey, () => string>>;
const facts = computed(() => details.value.facts.map((fact) => ({ ...fact, label: FACT_LABELS[fact.key]() })));
</script>

<template>
    <div class="flex flex-col gap-2" data-failure-details>
        <!-- Somebody else's words, quoted: a rule down their edge, never a box of their own on the card. -->
        <p
            v-if="prose.length > 0"
            class="max-h-32 overflow-auto border-l-2 border-line pl-2.5 break-words whitespace-pre-line text-muted select-text"
        >
            <template v-for="(run, index) in prose" :key="index"
                ><a v-if="`url` in run" :href="run.url" target="_blank" rel="noopener noreferrer" class="touch-target text-link hover:underline">{{
                    run.label
                }}</a
                ><template v-else>{{ run.text }}</template></template
            >
        </p>
        <!-- Labels in one column so the values line up; an id is mono and copies on its own, a category is a word. -->
        <dl v-if="facts.length > 0" class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3">
            <template v-for="fact in facts" :key="fact.key">
                <dt class="text-subtle">{{ fact.label }}</dt>
                <dd class="flex min-h-6 min-w-0 items-center gap-1">
                    <span class="min-w-0 truncate text-content select-text" :class="{ 'font-mono': fact.key !== `category` }">{{ fact.value }}</span>
                    <CopyButton
                        v-if="fact.key !== `category`"
                        :text="fact.value"
                        :aria-label="t(`chat.failure.copyValue`, { name: fact.label })"
                    />
                </dd>
            </template>
        </dl>
        <a
            v-if="details.learnMore"
            :href="details.learnMore"
            target="_blank"
            rel="noopener noreferrer"
            class="touch-target inline-flex items-center gap-1 self-start text-link hover:underline"
            >{{ t(`chat.failure.learnMore`) }}<Icon name="external-link" class="text-2xs"
        /></a>
    </div>
</template>
