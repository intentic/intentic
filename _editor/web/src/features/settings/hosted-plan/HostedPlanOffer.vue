<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { newSandboxLink } from "../../../models/sandbox/addSandbox";
import HostedTierCard from "./HostedTierCard.vue";
import type { Rung } from "./planLadder";

// The only buying surface in the product, built to be compared rather than read: one line of value, every machine as
// a card side by side with its own button (the cheapest on sale lifted as the recommendation), then the four
// answers people look for next to a price. Everything long-form lives in the page's questions, not here.
//
// Honest by construction: every figure comes from the ladder, a rung with no Stripe price offers no button, and the
// free rung is a real choice with its own way in rather than a foil.

const t = useT();

const props = defineProps<{
    ladder: readonly Rung[];
    // The rung this account's hosted machine already stands on, when it has one.
    currentTier?: string;
    // The rung whose checkout is being opened, so only that card's button waits.
    opening?: string;
}>();

const emit = defineEmits<{ checkout: [tier: string] }>();

const maxHours = computed(() => Math.max(...props.ladder.map((rung) => rung.hours)));

// A new sandbox, with the machine picked: the platform's from here, and this computer's for the other door. Made on
// Home, or in This computer's own window when Billing is open there (newSandboxLink).
const HOSTED_SETUP = newSandboxLink(`hosted`);
const OWN_SETUP = newSandboxLink();

const assurances = computed(() => [
    { icon: `undo` as const, title: t(`settings.hostedPlanOffer.cancelAnyTime`), body: t(`settings.hostedPlanOffer.cancelAnyTimeBody`) },
    { icon: `shield` as const, title: t(`settings.hostedPlanOffer.noOverage`), body: t(`settings.hostedPlanOffer.noOverageBody`) },
    { icon: `sliders-h` as const, title: t(`settings.hostedPlanOffer.switchAnyTime`), body: t(`settings.hostedPlanOffer.switchAnyTimeBody`) },
    { icon: `lock` as const, title: t(`settings.hostedPlanOffer.secureCheckout`), body: t(`settings.hostedPlanOffer.secureCheckoutBody`) },
]);
</script>

<template>
    <section class="flex flex-col gap-8" :aria-label="t(`settings.hostedPlanOffer.eyebrow`)">
        <header class="flex max-w-2xl flex-col gap-2">
            <span class="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-accent">
                <Icon name="cloud" class="text-sm" />
                {{ t(`settings.hostedPlanOffer.eyebrow`) }}
            </span>
            <h2 class="text-2xl font-semibold leading-tight tracking-tight text-content @2xl:text-[1.75rem]">
                {{ t(`settings.hostedPlanOffer.headline`) }}
            </h2>
            <p class="text-sm text-muted">{{ t(`settings.hostedPlanOffer.subhead`) }}</p>
        </header>

        <div class="grid grid-cols-1 items-stretch gap-x-4 gap-y-6 pt-2 @2xl:grid-cols-3">
            <!-- Stacked on a narrow column, the recommended card leads; side by side, the ladder keeps its order. -->
            <HostedTierCard
                v-for="rung in props.ladder"
                :key="rung.id"
                :rung="rung"
                :max-hours="maxHours"
                :current="rung.id === props.currentTier"
                :class="rung.recommended ? `order-first @2xl:order-none` : ``"
            >
                <template #action>
                    <!-- Free: the way in, or nothing to press once a machine already stands on it. -->
                    <template v-if="rung.free">
                        <Button v-if="rung.id === props.currentTier" :label="t(`settings.hostedPlanOffer.yourCurrentPlan`)" tier="quiet" disabled class="w-full" />
                        <Button v-else :as="RouterLink" :to="HOSTED_SETUP" :label="t(`settings.hostedPlanOffer.startFree`)" tier="boring" class="w-full" />
                    </template>
                    <Button
                        v-else-if="rung.onSale"
                        :label="t(`settings.hostedPlanOffer.getRung`, { name: rung.name })"
                        :tier="rung.recommended ? `loud` : `boring`"
                        :loading="props.opening === rung.id"
                        :disabled="props.opening !== undefined && props.opening !== rung.id"
                        class="w-full"
                        @click="emit(`checkout`, rung.id)"
                    />
                    <p v-else class="py-1.5 text-center text-2xs text-subtle">{{ t(`settings.hostedPlanOffer.notSoldHere`) }}</p>
                </template>
            </HostedTierCard>
        </div>

        <!-- The four questions asked at a price, answered in a line each. -->
        <ul class="grid grid-cols-1 gap-x-6 gap-y-4 @md:grid-cols-2 @3xl:grid-cols-4">
            <li v-for="item in assurances" :key="item.title" class="flex items-start gap-3">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-tint text-success">
                    <Icon :name="item.icon" class="text-sm" />
                </span>
                <div class="min-w-0">
                    <p class="text-xs font-semibold text-content">{{ item.title }}</p>
                    <p class="text-2xs text-muted">{{ item.body }}</p>
                </div>
            </li>
        </ul>

        <!-- The free alternative that costs nothing at all, offered plainly rather than hidden. -->
        <RouterLink
            :to="OWN_SETUP"
            class="group flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3 transition-colors hover:border-primary-fill/50 hover:bg-content/[0.03]"
        >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-content/[0.07] text-muted">
                <Icon name="desktop" class="text-sm" />
            </span>
            <span class="min-w-0 flex-1">
                <span class="block text-xs font-semibold text-content">{{ t(`settings.hostedPlanOffer.ownComputerTitle`) }}</span>
                <span class="block text-2xs text-muted">{{ t(`settings.hostedPlanOffer.ownComputerBody`) }}</span>
            </span>
            <Icon name="arrow-right" class="shrink-0 text-sm text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-link" />
        </RouterLink>
    </section>
</template>
