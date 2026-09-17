<script setup lang="ts">
import { Button, Card, Icon } from "@intentic/ui";
import { useHostedPlan } from "./useHostedPlan";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// The only thing this product charges for: a free hosted sandbox sleeps on an hour ceiling and gets removed after weeks
// unopened; the plan keeps it always on and never collected, changing nothing else (docs/design/pricing-model.md).
// Price comes from the plan state, not hardcoded, so a platform that charges differently is described correctly.

const t = useT();

const props = defineProps<{
    // Subscribe or Resubscribe: the last thing read before the decision.
    subscribeLabel: string;
    working?: boolean;
}>();

const emit = defineEmits<{ checkout: [] }>();

const { priceUsd } = useHostedPlan();

// What the money buys, stated as facts: the three things the plan changes about the free machine.
const buys = computed(() => [
    {
        icon: `bolt` as const,
        title: t(`settings.hostedPlanOffer.alwaysOn`),
        body: t(`settings.hostedPlanOffer.noAwakeHourCeiling`),
    },
    {
        icon: `shield` as const,
        title: t(`settings.hostedPlanOffer.neverRemoved`),
        body: t(`settings.hostedPlanOffer.freeMachineCollectedAfter`),
    },
    {
        icon: `box` as const,
        title: t(`settings.hostedPlanOffer.sameWorkspace`),
        body: t(`settings.hostedPlanOffer.everyFeatureCapabilityExtension`),
    },
]);

// The questions asked at the button, answered next to it rather than in a help page.
const assurances = computed(() => [
    {
        icon: `eye-slash` as const,
        title: t(`settings.hostedPlanOffer.nothingMetered`),
        body: t(`settings.hostedPlanOffer.noTokensCountedNo`),
    },
    {
        icon: `undo` as const,
        title: t(`settings.hostedPlanOffer.leaveAnyTime`),
        body: t(`settings.hostedPlanOffer.moveWorkspaceToOwn`),
    },
    {
        icon: `credit-card` as const,
        title: t(`settings.hostedPlanOffer.cancelAnyTime`),
        body: t(`settings.hostedPlanOffer.oneClickInStripes`),
    },
]);
</script>

<template>
    <!-- Accent-tinted hero: the first thing a new reader should land on, price boxed on the side the eye finishes on. -->
    <Card class="border-primary-fill/25 bg-primary-fill/[0.07]">
        <div class="flex flex-col gap-5 @2xl:flex-row @2xl:items-center @2xl:gap-8">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <Icon name="star" class="text-base text-link" />
                    <span class="text-2xs font-semibold uppercase tracking-wider text-link">{{ t(`settings.hostedPlanOffer.hosted`) }}</span>
                </div>
                <h2 class="mt-3 text-2xl font-semibold leading-tight text-content">{{ t(`settings.hostedPlanOffer.keepHostedSandboxAlways`) }}</h2>
                <p class="mt-2 text-sm text-muted">
                    {{ t(`settings.hostedPlanOffer.freeMachineSleepsAfter`) }}
                </p>
            </div>

            <div class="shrink-0 rounded-lg border border-line bg-card p-4 @2xl:w-64">
                <div class="flex items-baseline gap-1.5">
                    <span class="text-4xl font-semibold leading-none tracking-tight text-content">${{ priceUsd }}</span>
                    <span class="text-sm text-muted">/month</span>
                </div>
                <!-- A slot is a machine: stated next to the price. -->
                <p class="mt-1 text-2xs text-subtle">{{ t(`settings.hostedPlanOffer.perHostedSandbox`) }}</p>
                <Button :label="props.subscribeLabel" :loading="props.working" class="ui-button-loud mt-3 w-full" @click="emit(`checkout`)" />
                <p class="mt-2 text-center text-2xs text-subtle">{{ t(`settings.hostedPlanOffer.paidThroughStripeCancel`) }}</p>
            </div>
        </div>
    </Card>

    <div class="grid grid-cols-1 gap-3 @xl:grid-cols-3">
        <Card v-for="item in buys" :key="item.title" class="flex flex-col gap-1">
            <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon :name="item.icon" /></span>
            <p class="mt-1.5 text-lg font-semibold leading-tight text-content">{{ item.title }}</p>
            <p class="text-xs text-muted">{{ item.body }}</p>
        </Card>
    </div>

    <Card>
        <div class="grid grid-cols-1 gap-x-6 gap-y-3 @lg:grid-cols-3">
            <div v-for="item in assurances" :key="item.title" class="flex gap-2.5">
                <Icon :name="item.icon" class="mt-0.5 shrink-0 text-sm text-success" />
                <div class="min-w-0">
                    <p class="text-xs font-semibold text-content">{{ item.title }}</p>
                    <p class="text-xs text-muted">{{ item.body }}</p>
                </div>
            </div>
        </div>
        <div class="mt-7 flex flex-wrap items-center gap-x-4 gap-y-3">
            <Button :label="props.subscribeLabel" :loading="props.working" class="ui-button-loud" @click="emit(`checkout`)" />
            <!-- Not "leave": moving the workspace to your own machine costs nothing. -->
            <RouterLink :to="{ name: `setup` }" class="text-xs text-link hover:underline">{{
                t(`settings.hostedPlanOffer.runOnOwnComputer`)
            }}</RouterLink>
        </div>
    </Card>
</template>
