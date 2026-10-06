<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type FailureFactKey, failureDetails } from "./providerFailure";

// Everything a failure row folded behind its one line (providerFailure.ts), opened under it: the provider's prose with
// its paragraphs and links kept, the ids a support request asks for, each with its own copy, and the whole message to
// copy word for word. Opened by a press rather than a hover, since what it holds is meant to be clicked and selected.

const { said } = defineProps<{ said: string }>();

const t = useT();
const details = computed(() => failureDetails(said));

const FACT_LABELS = {
    category: () => t(`chat.providerFailure.category`),
    request: () => t(`chat.providerFailure.requestId`),
    message: () => t(`chat.providerFailure.messageId`),
} as const satisfies Readonly<Record<FailureFactKey, () => string>>;
const facts = computed(() => details.value.facts.map((fact) => ({ ...fact, label: FACT_LABELS[fact.key]() })));
</script>

<template>
    <div class="chat-inset flex w-full flex-col gap-2 px-3 py-2 text-left text-2xs leading-relaxed" data-failure-details>
        <p v-if="details.prose.length > 0" class="break-words whitespace-pre-line select-text">
            <template v-for="(run, index) in details.prose" :key="index"
                ><a v-if="`url` in run" :href="run.url" target="_blank" rel="noopener noreferrer" class="text-link hover:underline">{{ run.label }}</a
                ><template v-else>{{ run.text }}</template></template
            >
        </p>
        <!-- Labels in one column so the values line up; an id is mono and copies on its own, a category is a word. -->
        <dl v-if="facts.length > 0" class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3">
            <template v-for="fact in facts" :key="fact.key">
                <dt class="text-subtle">{{ fact.label }}</dt>
                <dd class="flex min-h-6 min-w-0 items-center gap-1">
                    <span class="min-w-0 break-all text-content select-text" :class="{ 'font-mono': fact.key !== `category` }">{{ fact.value }}</span>
                    <CopyButton v-if="fact.key !== `category`" :text="fact.value" :aria-label="t(`chat.providerFailure.copyValue`, { name: fact.label })" />
                </dd>
            </template>
        </dl>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a
                v-if="details.learnMore"
                :href="details.learnMore"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-link hover:underline"
                >{{ t(`chat.providerFailure.learnMore`) }}<Icon name="external-link" class="text-2xs"
            /></a>
            <!-- The message as the provider sent it, ids and links in place: what a bug report or a support ticket wants. -->
            <CopyButton :text="said" :label="t(`chat.providerFailure.copyDetails`)" class="ml-auto" />
        </div>
    </div>
</template>
