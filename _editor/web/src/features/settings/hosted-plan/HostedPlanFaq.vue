<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// The terms, as the questions people actually ask before paying, folded until asked. Each answer is a sentence or two:
// what an hour is, what running out does, what is never counted, how teams and cancelling work.

const t = useT();

const props = defineProps<{ freeHours: number }>();

const questions = computed(() => [
    { q: t(`settings.hostedPlanFaq.awakeQ`), a: t(`settings.hostedPlanFaq.awakeA`) },
    { q: t(`settings.hostedPlanFaq.runOutQ`), a: t(`settings.hostedPlanFaq.runOutA`) },
    { q: t(`settings.hostedPlanFaq.freeQ`), a: t(`settings.hostedPlanFaq.freeA`, { hours: props.freeHours }) },
    { q: t(`settings.hostedPlanFaq.switchQ`), a: t(`settings.hostedPlanFaq.switchA`) },
    { q: t(`settings.hostedPlanFaq.ownQ`), a: t(`settings.hostedPlanFaq.ownA`) },
    { q: t(`settings.hostedPlanFaq.teamsQ`), a: t(`settings.hostedPlanFaq.teamsA`) },
    { q: t(`settings.hostedPlanFaq.cancelQ`), a: t(`settings.hostedPlanFaq.cancelA`) },
]);
</script>

<template>
    <section class="flex flex-col gap-3">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-content">
            <Icon name="question-circle" class="text-base text-subtle" />
            {{ t(`settings.hostedPlanFaq.title`) }}
        </h2>
        <div class="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            <details v-for="item in questions" :key="item.q" class="group">
                <summary
                    class="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-xs font-medium text-content transition-colors hover:bg-content/[0.03] [&::-webkit-details-marker]:hidden"
                >
                    {{ item.q }}
                    <Icon name="chevron-down" class="shrink-0 text-sm text-subtle transition-transform group-open:rotate-180" />
                </summary>
                <p class="px-4 pb-3.5 text-xs leading-relaxed text-muted">{{ item.a }}</p>
            </details>
        </div>
    </section>
</template>
