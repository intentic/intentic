<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";
import { type HostedTierId, isHostedTierId } from "@intentic/constants";
import { formatCount } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { hoursPerWorkday, type Rung } from "./planLadder";

// One rung of the ladder as a card a person can compare at a glance: price on top, the hours as a bar against the
// biggest rung (the one figure that differs most), the machine as three icon lines, then what the rung promises.
// The action is the caller's (#action): a checkout, a start, or a subscriber's slot controls.

const t = useT();

const props = defineProps<{
    rung: Rung;
    // The biggest rung's hours, so every card's bar is drawn on the same scale.
    maxHours: number;
    // The rung this account's machine stands on now.
    current?: boolean;
}>();

// Each rung's mark and the one line saying who it is for. A rung added to the ladder without a line here still draws,
// as a plain server with no tagline.
const LOOK = {
    free: { icon: `sparkles`, tagline: () => t(`settings.hostedTierCard.taglineFree`) },
    standard: { icon: `bolt`, tagline: () => t(`settings.hostedTierCard.taglineStandard`) },
    max: { icon: `server`, tagline: () => t(`settings.hostedTierCard.taglineMax`) },
} as const satisfies Record<HostedTierId, { icon: IconName; tagline: () => string }>;
const look = computed(() => (isHostedTierId(props.rung.id) ? LOOK[props.rung.id] : undefined));
const icon = computed<IconName>(() => look.value?.icon ?? `server`);
const tagline = computed(() => look.value?.tagline() ?? ``);

const share = computed(() => Math.max(0.04, Math.min(1, props.rung.hours / Math.max(1, props.maxHours))));

const specs = computed(() => [
    {
        icon: `cpu` as const,
        text:
            props.rung.machine.cpuKind === `shared`
                ? t(`settings.hostedTierCard.sharedCpus`, { cpus: props.rung.machine.cpus }, props.rung.machine.cpus)
                : t(`settings.hostedTierCard.performanceCpus`, { cpus: props.rung.machine.cpus }, props.rung.machine.cpus),
    },
    { icon: `boxes` as const, text: t(`settings.hostedTierCard.memory`, { gb: formatCount(props.rung.machine.memoryMb / 1024) }) },
    { icon: `database` as const, text: t(`settings.hostedTierCard.disk`, { gb: props.rung.machine.volumeGb }) },
]);

// What the rung promises beyond its machine; the free rung's two limits are said as limits, in a quieter ink.
const perks = computed(() =>
    props.rung.free
        ? [
              { good: true, text: t(`settings.hostedTierCard.everyFeature`) },
              { good: false, text: t(`settings.hostedTierCard.hoursShared`) },
              { good: false, text: t(`settings.hostedTierCard.removedWhenIdle`) },
          ]
        : [
              { good: true, text: t(`settings.hostedTierCard.everyFeature`) },
              { good: true, text: t(`settings.hostedTierCard.hoursOwn`) },
              { good: true, text: t(`settings.hostedTierCard.keptForGood`) },
          ],
);
</script>

<template>
    <article
        class="relative flex flex-col rounded-xl border p-5 transition-colors"
        :class="props.rung.recommended ? `border-primary-fill/60 bg-primary-tint shadow-md` : `border-line bg-card`"
        :aria-label="props.rung.name"
    >
        <span
            v-if="props.rung.recommended"
            class="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-primary-fill px-2.5 py-0.5 text-2xs font-semibold text-fill-content shadow-sm"
        >
            <Icon name="star-fill" class="text-[0.7rem]" />
            {{ t(`settings.hostedTierCard.recommended`) }}
        </span>

        <header class="flex items-center gap-3">
            <span
                class="flex size-9 shrink-0 items-center justify-center rounded-lg text-base"
                :class="props.rung.recommended ? `bg-primary-fill text-fill-content` : `bg-content/[0.07] text-accent`"
            >
                <Icon :name="icon" />
            </span>
            <div class="min-w-0 flex-1">
                <h3 class="text-base font-semibold leading-tight text-content">{{ props.rung.name }}</h3>
                <p v-if="tagline" class="text-2xs text-muted">{{ tagline }}</p>
            </div>
            <span v-if="props.current" class="shrink-0 rounded-full bg-success-tint px-2 py-0.5 text-2xs font-medium text-success">
                {{ t(`settings.hostedTierCard.current`) }}
            </span>
        </header>

        <div class="mt-5 flex items-baseline gap-1">
            <span class="text-3xl font-semibold leading-none tracking-tight text-content tabular-nums">${{ props.rung.priceUsd }}</span>
            <span class="text-xs text-muted">{{ t(`settings.hostedTierCard.perMonth`) }}</span>
        </div>
        <p class="mt-1 text-2xs text-subtle">
            {{ props.rung.free ? t(`settings.hostedTierCard.noCard`) : t(`settings.hostedTierCard.perSandbox`) }}
        </p>

        <!-- The hours, drawn against the biggest rung's: the difference a person is paying for, seen before it is read. -->
        <div class="mt-5">
            <div class="flex items-baseline justify-between gap-2">
                <span class="text-sm font-semibold text-content tabular-nums">{{ t(`settings.hostedTierCard.hours`, { hours: props.rung.hours }) }}</span>
                <span class="text-2xs text-muted tabular-nums">{{ t(`settings.hostedTierCard.perWorkday`, { hours: hoursPerWorkday(props.rung.hours) }) }}</span>
            </div>
            <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-content/10" aria-hidden="true">
                <div class="ui-grow-x h-full rounded-full" :class="props.rung.free ? `bg-content/35` : `bg-primary-fill`" :style="{ width: `${Math.round(share * 100)}%` }" />
            </div>
            <p class="mt-1 text-2xs text-subtle">
                {{ props.rung.free ? t(`settings.hostedTierCard.awakeHoursShared`) : t(`settings.hostedTierCard.awakeHoursOwn`) }}
            </p>
        </div>

        <ul class="mt-4 flex flex-col gap-2 text-xs text-content">
            <li v-for="spec in specs" :key="spec.icon" class="flex items-center gap-2.5">
                <Icon :name="spec.icon" class="shrink-0 text-sm text-subtle" />
                <span>{{ spec.text }}</span>
            </li>
        </ul>

        <hr class="my-4 border-line" />

        <ul class="flex flex-1 flex-col gap-2 text-xs">
            <li v-for="perk in perks" :key="perk.text" class="flex items-start gap-2.5" :class="perk.good ? `text-content` : `text-muted`">
                <Icon :name="perk.good ? `check` : `minus`" class="shrink-0 text-sm" :class="perk.good ? `text-success` : `text-subtle`" />
                <span>{{ perk.text }}</span>
            </li>
        </ul>

        <div v-if="$slots[`action`]" class="mt-5 flex flex-col gap-2">
            <slot name="action" />
        </div>
    </article>
</template>
