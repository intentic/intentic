<script setup lang="ts">
import type { CheckoutPress, CheckoutUsage } from "@intentic/sandbox-contract/schemas/metrics";
import { Button, ConfirmDialog } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatBytes, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { mobileChatPath } from "../../../../lib/routes/phoneScreens";
import { checkoutParts, checkoutTotal, LEADING_CHECKOUTS, landedReleasable } from "./checkoutsView";
import { checkoutPartLabel, checkoutStateLabel } from "./checkoutLabels";
import { PRESSING_MANY } from "./useSandboxStorage";

// Every conversation's checkout on the history volume, largest first, with what may be done with each now (the daemon's
// checkout-usage.ts says, by the rules it applies when asked): free its build output, free the checkout itself (its work
// is committed onto its branch and its next turn brings it back), or move a leftover nobody owns to the trash. Sizes
// are the last scan's; a press takes the row's own figures off without measuring again.

const t = useT();
const props = defineProps<{
    rows: readonly CheckoutUsage[];
    // The conversation a press is running for; every other press waits for it.
    pressing: string | undefined;
    // A scan or a category clean is running: the figures are about to change under the rows.
    disabled: boolean;
}>();
// `name` is what the run is called in the operations ledger: the conversation's, or the batch's.
const emit = defineEmits<{ press: [rows: readonly CheckoutUsage[], press: CheckoutPress, name: string] }>();

const now = useNow(() => props.rows.length > 0, 60_000);
const total = computed(() => props.rows.reduce((sum, row) => sum + checkoutTotal(row), 0));
const showAll = ref(false);
const shown = computed(() => (showAll.value || props.rows.length <= LEADING_CHECKOUTS + 1 ? props.rows : props.rows.slice(0, LEADING_CHECKOUTS)));
const landed = computed(() => landedReleasable(props.rows));

const nameOf = (row: CheckoutUsage): string => row.title ?? (row.state === `leftover` ? t(`sandbox.storageCheckouts.leftoverName`) : row.id);

const detailOf = (row: CheckoutUsage): string =>
    [
        checkoutStateLabel(row.state),
        ...(row.updatedAt === undefined ? [] : [t(`sandbox.storageCheckouts.active`, { when: timeAgo(row.updatedAt, { now: now.value, days: true }) })]),
        ...checkoutParts(row).map(checkoutPartLabel),
    ].join(` · `);

// A leftover may hold work nobody committed: the trash keeps it a while, and that is said before it goes.
const trashing = ref<CheckoutUsage>();
const confirmTrash = (): void => {
    const row = trashing.value;
    trashing.value = undefined;
    if (row !== undefined) {
        emit(`press`, [row], `trash`, nameOf(row));
    }
};

// Landed checkouts one after another in one run: each press is the daemon's own, refused if that one's state moved.
const freeLanded = (): void => {
    emit(`press`, landed.value, `release`, t(`sandbox.storageCheckouts.landedName`, { count: landed.value.length }, landed.value.length));
};
</script>

<template>
    <section v-if="rows.length > 0" class="flex flex-col gap-1.5 border-t border-line-subtle pt-3" data-storage-checkouts>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h4 class="text-xs font-medium text-content">{{ t(`sandbox.storageCheckouts.heading`) }}</h4>
            <span class="text-2xs tabular-nums text-subtle">{{
                t(`sandbox.storageCheckouts.summary`, { count: rows.length, bytes: formatBytes(total) }, rows.length)
            }}</span>
            <Button
                v-if="landed.length > 1"
                class="ml-auto"
                size="small"
                tier="boring"
                :label="t(`sandbox.storageCheckouts.freeLanded`, { count: landed.length }, landed.length)"
                :loading="pressing === PRESSING_MANY"
                :disabled="disabled || pressing !== undefined"
                v-tooltip.top="t(`sandbox.storageCheckouts.releaseNote`)"
                @click="freeLanded"
            >
                <template #icon><Icon name="box" /></template>
            </Button>
        </div>
        <p class="text-2xs leading-relaxed text-muted">{{ t(`sandbox.storageCheckouts.intro`) }}</p>

        <ul class="flex flex-col">
            <li
                v-for="row in shown"
                :key="row.id"
                class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle py-1.5 first:border-t-0"
                :data-checkout="row.id"
                :data-state="row.state"
            >
                <div class="flex min-w-0 flex-1 basis-48 flex-col">
                    <RouterLink
                        v-if="row.state !== `leftover`"
                        :to="mobileChatPath(row.id)"
                        class="min-w-0 truncate text-xs text-content hover:underline"
                        v-tooltip.top.overflow="nameOf(row)"
                        >{{ nameOf(row) }}</RouterLink
                    >
                    <span v-else class="min-w-0 truncate text-xs text-content" v-tooltip.top="row.id">{{ nameOf(row) }}</span>
                    <span class="min-w-0 truncate text-2xs text-subtle" v-tooltip.top.overflow="detailOf(row)">{{ detailOf(row) }}</span>
                </div>
                <span class="text-xs tabular-nums text-content">{{ formatBytes(checkoutTotal(row)) }}</span>
                <div class="flex items-center gap-1.5">
                    <Button
                        v-if="row.can.cleanBuildOutput"
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.storageCheckouts.cleanBuildOutput`, { bytes: formatBytes(row.buildOutputBytes) })"
                        :loading="pressing === row.id"
                        :disabled="disabled || (pressing !== undefined && pressing !== row.id)"
                        v-tooltip.top="t(`sandbox.storageCheckouts.cleanBuildOutputNote`)"
                        data-press="cleanBuildOutput"
                        @click="emit(`press`, [row], `cleanBuildOutput`, nameOf(row))"
                    >
                        <template #icon><Icon name="eraser" /></template>
                    </Button>
                    <Button
                        v-if="row.can.release"
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.storageCheckouts.release`)"
                        :disabled="disabled || pressing !== undefined"
                        v-tooltip.top="t(`sandbox.storageCheckouts.releaseNote`)"
                        data-press="release"
                        @click="emit(`press`, [row], `release`, nameOf(row))"
                    >
                        <template #icon><Icon name="box" /></template>
                    </Button>
                    <Button
                        v-if="row.can.trash"
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.storageCheckouts.trash`)"
                        :disabled="disabled || pressing !== undefined"
                        data-press="trash"
                        @click="trashing = row"
                    >
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </div>
            </li>
        </ul>

        <button
            v-if="rows.length > LEADING_CHECKOUTS + 1"
            type="button"
            class="flex cursor-pointer items-center gap-1.5 self-start text-xs text-muted hover:text-content"
            :aria-expanded="showAll"
            @click="showAll = !showAll"
        >
            <Icon :name="showAll ? `chevron-up` : `chevron-down`" class="text-2xs text-subtle" />
            {{ showAll ? t(`sandbox.storageCheckouts.showFewer`) : t(`sandbox.storageCheckouts.showAll`, { count: rows.length }) }}
        </button>

        <ConfirmDialog
            :open="trashing !== undefined"
            :header="t(`sandbox.storageCheckouts.trashHeader`)"
            :description="trashing?.id"
            header-icon="trash"
            :confirm-label="t(`sandbox.storageCheckouts.trash`)"
            size="md"
            @cancel="trashing = undefined"
            @confirm="confirmTrash"
        >
            <p>{{ t(`sandbox.storageCheckouts.trashWarning`) }}</p>
        </ConfirmDialog>
    </section>
</template>
