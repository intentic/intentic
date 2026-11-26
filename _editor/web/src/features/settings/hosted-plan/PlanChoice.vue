<!-- THE PLANS A CLOUD SANDBOX CAN BE ON, as one radio list: the change dialog's (PlanDialog.vue) and the new sandbox's
     (AddSandboxForm.vue). Each row says what the plan is (its size, its hours, whether it is kept), what it costs, and how
     it stands for this sandbox: the plan it is on now, the one a change waiting moves it to, or why it cannot be picked
     (Free, held by another sandbox). Drawn like the form's "Runs on" rows: on the surface's own ground, the pick a tint and
     a filled circle. `compact` is the new sandbox's: name and price only, three across where there is room. -->
<script setup lang="ts">
import { formatCount } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import type { Rung } from "./planLadder";

const {
    rungs,
    current = undefined,
    scheduled = undefined,
    refused = {},
    compact = false,
} = defineProps<{
    rungs: readonly Rung[];
    /** The plan the sandbox is on now. */
    current?: string | undefined;
    /** The plan a change waiting moves it to, and when, already in words ("from Dec 26"). */
    scheduled?: { readonly tier: string; readonly when: string } | undefined;
    /** Plans that cannot be picked, each with why. */
    refused?: Readonly<Record<string, string>>;
    compact?: boolean;
    /** The id of the label naming the list. */
    labelledBy: string;
}>();
const pick = defineModel<string>({ required: true });

const t = useT();

const note = (rung: Rung): string =>
    t(`settings.plans.rowNote`, {
        cpus: rung.machine.cpus,
        memory: formatCount(rung.machine.memoryMb / 1024),
        disk: rung.machine.volumeGb,
        hours: rung.hours,
        kept: rung.free ? t(`settings.plans.keptFree`) : t(`settings.plans.keptForGood`),
    });
const price = (rung: Rung): string => (rung.free ? t(`settings.plans.priceFree`) : t(`settings.plans.perMonth`, { price: rung.priceUsd }));

// One tab stop, the pick; the arrows move it along the plans that can be picked, as in any radio group.
const group = ref<HTMLElement>();
const STEPS = new Map([
    [`ArrowDown`, 1],
    [`ArrowRight`, 1],
    [`ArrowUp`, -1],
    [`ArrowLeft`, -1],
]);
const step = (event: KeyboardEvent): void => {
    const by = STEPS.get(event.key);
    const open = rungs.filter((rung) => refused[rung.id] === undefined);
    if (by === undefined || open.length === 0) {
        return;
    }
    event.preventDefault();
    const at = open.findIndex((rung) => rung.id === pick.value);
    const next = open[(at + by + open.length) % open.length];
    if (next !== undefined) {
        pick.value = next.id;
        group.value?.querySelector<HTMLButtonElement>(`[data-plan-choice="${next.id}"]`)?.focus();
    }
};
</script>

<template>
    <div class="@container">
        <div
            ref="group"
            role="radiogroup"
            :aria-labelledby="labelledBy"
            class="-mx-2.5 grid grid-cols-1 gap-0.5"
            :class="compact ? `@md:grid-cols-3 @md:gap-x-1` : ``"
            @keydown="step"
        >
            <button
                v-for="rung in rungs"
                :key="rung.id"
                type="button"
                role="radio"
                :aria-checked="pick === rung.id"
                :aria-disabled="refused[rung.id] !== undefined"
                :tabindex="pick === rung.id ? 0 : -1"
                class="ui-row-select flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left max-md:py-2.5"
                :class="{ 'ui-row-select-on': pick === rung.id, 'cursor-not-allowed opacity-60': refused[rung.id] !== undefined }"
                :data-plan-choice="rung.id"
                @click="refused[rung.id] === undefined && (pick = rung.id)"
            >
                <Icon
                    :name="pick === rung.id ? `check-circle` : `circle`"
                    class="shrink-0 text-sm"
                    :class="pick === rung.id ? `text-accent` : `text-subtle`"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span class="text-sm font-medium text-content">{{ rung.name }}</span>
                        <span v-if="rung.id === current" class="text-2xs text-subtle">{{ t(`settings.plans.tagCurrent`) }}</span>
                        <span v-else-if="rung.id === scheduled?.tier" class="text-2xs text-warning">{{ scheduled.when }}</span>
                    </span>
                    <span v-if="refused[rung.id]" class="text-xs leading-snug text-muted">{{ refused[rung.id] }}</span>
                    <span v-else-if="compact" class="text-xs leading-snug text-muted tabular-nums">{{ price(rung) }}</span>
                    <span v-else class="text-xs leading-snug text-muted">{{ note(rung) }}</span>
                </span>
                <span v-if="!compact" class="shrink-0 text-sm font-medium text-content tabular-nums">{{ price(rung) }}</span>
            </button>
        </div>
    </div>
</template>
