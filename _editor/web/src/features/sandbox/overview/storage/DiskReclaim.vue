<script setup lang="ts">
import type { StorageCategoryId, StorageScan } from "@intentic/sandbox-contract/schemas/metrics";
import { Button, Icon, ResponsiveOverlay, Row } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, ref } from "vue";
import { choiceBytes, cleanChoices } from "./diskMap";
import { storageCategoryLabel, storageCategoryText } from "./storageCategories";

// Getting space back in one decision (2026-11-24): every category the daemon would clean now, in one list, the safe
// ones ticked, the ones that cost something unticked beside what they cost. The press that opens the list never
// cleans anything; the list's own button does, once, for everything ticked, and the card measures again after.

const t = useT();

const { scan, busy, loading } = defineProps<{
    scan: StorageScan;
    /** A scan or a clean is running: the figures are about to change. */
    busy: boolean;
    /** This list's own clean is the one running. */
    loading: boolean;
}>();
const emit = defineEmits<{ clean: [categories: readonly StorageCategoryId[]] }>();

const choices = computed(() => cleanChoices(scan.categories));
const safeBytes = computed(() => choiceBytes(choices.value.filter((choice) => !choice.confirm)));
const askedBytes = computed(() => choiceBytes(choices.value.filter((choice) => choice.confirm)));

// What one press could give back, and what more the reader could choose to.
const summary = computed(() => {
    if (choices.value.length === 0) {
        return t(`sandbox.diskReclaim.nothing`);
    }
    if (askedBytes.value === 0) {
        return t(`sandbox.diskReclaim.safe`, { bytes: formatBytes(safeBytes.value) });
    }
    if (safeBytes.value === 0) {
        return t(`sandbox.diskReclaim.asked`, { bytes: formatBytes(askedBytes.value) });
    }
    return t(`sandbox.diskReclaim.both`, { safe: formatBytes(safeBytes.value), asked: formatBytes(askedBytes.value) });
});

const anchor = ref<HTMLElement>();
const open = ref(false);
const ticked = ref<ReadonlySet<StorageCategoryId>>(new Set());

// Each opening starts from the safe ones: what the reader ticked last time was a decision about an older scan.
const start = (): void => {
    ticked.value = new Set(choices.value.filter((choice) => !choice.confirm).map((choice) => choice.id));
    open.value = true;
};
const tick = (id: StorageCategoryId, on: boolean): void => {
    const next = new Set(ticked.value);
    if (on) {
        next.add(id);
    } else {
        next.delete(id);
    }
    ticked.value = next;
};

const chosen = computed(() => choices.value.filter((choice) => ticked.value.has(choice.id)));
const costly = computed(() => chosen.value.some((choice) => choice.confirm));
const chosenBytes = computed(() => choiceBytes(chosen.value));

const go = (): void => {
    open.value = false;
    emit(
        `clean`,
        chosen.value.map((choice) => choice.id),
    );
};
</script>

<template>
    <Row :title="t(`sandbox.diskReclaim.title`)" :description="summary" data-disk-reclaim>
        <template #control>
            <span ref="anchor" class="inline-flex">
                <Button
                    size="small"
                    tier="boring"
                    :label="t(`sandbox.diskReclaim.cleanUp`)"
                    :loading="loading"
                    :disabled="busy || choices.length === 0"
                    @click="start"
                >
                    <template #icon><Icon name="eraser" /></template>
                </Button>
            </span>
        </template>
    </Row>

    <ResponsiveOverlay
        v-model="open"
        :anchor="anchor"
        :header="t(`sandbox.diskReclaim.what`)"
        titled
        padded
        side="bottom"
        cross="end"
        panel-class="w-[26rem] max-w-[calc(100vw-2rem)]"
    >
        <ul class="flex flex-col" data-disk-reclaim-list>
            <li v-for="choice in choices" :key="choice.id" class="border-t border-line-subtle first:border-t-0">
                <label class="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 py-2" :data-disk-choice="choice.id">
                    <Checkbox binary size="small" :model-value="ticked.has(choice.id)" @update:model-value="(on: boolean) => tick(choice.id, on)" />
                    <span class="min-w-0 truncate text-sm text-content">{{ storageCategoryLabel(choice.id) }}</span>
                    <span class="text-xs tabular-nums text-muted">{{
                        choice.exact ? formatBytes(choice.bytes) : t(`sandbox.diskReclaim.upTo`, { bytes: formatBytes(choice.bytes) })
                    }}</span>
                    <!-- What it costs, said before it is ticked and in the warning ink once it is. -->
                    <span
                        v-if="choice.confirm"
                        class="col-span-2 col-start-2 text-xs leading-relaxed"
                        :class="ticked.has(choice.id) ? `text-warning` : `text-subtle`"
                        >{{ storageCategoryText({ id: choice.id, cleanability: `confirm` }).warning }}</span
                    >
                </label>
            </li>
        </ul>
        <div class="mt-3 flex justify-end gap-2 border-t border-line-subtle pt-3">
            <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="open = false" />
            <Button
                size="small"
                tier="accent"
                :tone="costly ? `danger` : undefined"
                :label="t(`sandbox.diskReclaim.clean`, { bytes: formatBytes(chosenBytes) })"
                :disabled="chosen.length === 0"
                data-disk-reclaim-go
                @click="go"
            />
        </div>
    </ResponsiveOverlay>
</template>
