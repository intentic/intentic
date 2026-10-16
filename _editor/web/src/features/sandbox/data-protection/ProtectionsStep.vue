<script setup lang="ts">
import type { Measure, PresetItem } from "@intentic/sandbox-contract";
import { Button, ConfirmDialog, InfoHint, Notice, type NoticeModel, Row, RowGroup, RowNote, SkeletonRows, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useRole } from "../../../client/sandbox/useRole";
import HintedTitle from "./HintedTitle.vue";
import { keyOf, MEASURE_LINKS, planProtections, presetLabel, presetValue, STATUS_TONE } from "./dataProtection";
import { useComplianceReport, usePreset } from "./useCompliance";

// Step 1: every protection the sandbox offers, sorted by what the reader can do about it. Recommended first: the
// public-office preset's changes, each filed under the protection it switches and ticked to start with, applied
// together after a confirmation. Then what else could be switched on where it lives, then, folded away, what is in
// place. One list where there were two: the protections under six GDPR headings and the preset below them named most
// switches twice. What each protection does is behind the (i) beside its name: the name says enough to scan the list,
// and three lines of explanation under every row made the list the longest thing on the page.

const t = useT();
const { isOwner } = useRole();
const { report, isLoading: reportLoading } = useComplianceReport();
const { items, error: presetError, isLoading: presetLoading, apply } = usePreset();

const plan = computed(() => planProtections(report.value?.measures ?? [], items.value ?? []));
const changeable = computed(() => plan.value.recommended.flatMap((entry) => entry.changes));

// Every change starts ticked: the preset is a recommendation, and unticking is the deliberate act.
const chosen = ref<Set<string>>();
const picked = computed<ReadonlySet<string>>(() => chosen.value ?? new Set(changeable.value.map((item) => item.id)));
const toggle = (item: PresetItem, on: boolean): void => {
    const next = new Set(picked.value);
    if (on) {
        next.add(item.id);
    } else {
        next.delete(item.id);
    }
    chosen.value = next;
};
const pickedItems = computed(() => changeable.value.filter((item) => picked.value.has(item.id)));

const confirming = ref(false);
const outcome = ref<NoticeModel>();
const applyPicked = async (): Promise<void> => {
    confirming.value = false;
    outcome.value = undefined;
    try {
        const result = await apply.mutateAsync(pickedItems.value.map((item) => item.id));
        chosen.value = undefined;
        const done: NoticeModel = { tone: `success`, title: t(`sandbox.dataProtection.applied`, { count: result.applied.length }, result.applied.length) };
        outcome.value =
            result.skipped.length === 0 ? done : { ...done, detail: t(`sandbox.dataProtection.skipped`, { count: result.skipped.length }, result.skipped.length) };
    } catch (error) {
        outcome.value = noticeFrom(error, t(`sandbox.dataProtection.couldntApply`));
    }
};

// What is in place is the least of anyone's business here, so it opens on asking.
const showInPlace = ref(false);

const nameOf = (measure: Measure): string => t(`sandbox.dataProtection.measure.${keyOf(measure.id)}.name`);
const whatOf = (measure: Measure): string => t(`sandbox.dataProtection.measure.${keyOf(measure.id)}.what`);
const statusOf = (measure: Measure): string => t(`sandbox.dataProtection.status.${measure.status}`);
const reasonOf = (item: PresetItem): string => t(`sandbox.dataProtection.unavailable.${keyOf(item.id)}`);
</script>

<template>
    <div class="flex flex-col gap-6">
        <SkeletonRows v-if="reportLoading || presetLoading" :rows="6" description />
        <template v-else>
            <Notice v-if="presetError" :of="{ tone: `danger`, title: t(`sandbox.dataProtection.couldntReadPreset`), detail: presetError }" />
            <Notice v-if="outcome" :of="outcome" />

            <div v-if="plan.recommended.length > 0" class="flex flex-col gap-3">
                <RowGroup :label="t(`sandbox.dataProtection.recommended`)">
                    <template #info>
                        <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.dataProtection.recommended`) })">
                            <span class="block text-xs text-content">{{ t(`sandbox.dataProtection.recommendedHint`) }}</span>
                        </InfoHint>
                    </template>
                    <Row v-for="entry in plan.recommended" :key="entry.measure.id" indent>
                        <template #title><HintedTitle :title="nameOf(entry.measure)">{{ whatOf(entry.measure) }}</HintedTitle></template>
                        <template #control>
                            <StatusBadge :variant="STATUS_TONE[entry.measure.status]" dot :label="statusOf(entry.measure)" />
                        </template>
                        <template #below>
                            <div class="flex flex-col gap-1.5">
                                <label v-for="item in entry.changes" :key="item.id" class="flex cursor-pointer items-start gap-2 text-xs">
                                    <Checkbox
                                        :model-value="picked.has(item.id)"
                                        binary
                                        size="small"
                                        :disabled="!isOwner"
                                        :input-id="`preset-${item.id}`"
                                        @update:model-value="(on: unknown) => toggle(item, on === true)"
                                    />
                                    <span>
                                        <span class="text-content">{{ presetLabel(item) }}:</span>
                                        <span class="px-1 text-muted">{{ presetValue(item, item.current) }} →</span>
                                        <span class="font-medium text-content">{{ presetValue(item, item.proposed) }}</span>
                                    </span>
                                </label>
                                <p v-for="item in entry.unavailable" :key="item.id" class="text-xs text-muted">{{ presetLabel(item) }}: {{ reasonOf(item) }}</p>
                            </div>
                        </template>
                    </Row>
                </RowGroup>
                <!-- Held in view while the list scrolls under it: the press that does what the ticks above say. -->
                <div class="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 bg-canvas/90 py-2 backdrop-blur">
                    <Button tone="accent" :disabled="!isOwner || pickedItems.length === 0" :loading="apply.isPending.value" @click="confirming = true">
                        {{ t(`sandbox.dataProtection.apply`, { count: pickedItems.length }, pickedItems.length) }}
                    </Button>
                    <span class="text-xs text-muted">{{ isOwner ? t(`sandbox.dataProtection.applyNote`) : t(`sandbox.dataProtection.ownerApplies`) }}</span>
                </div>
            </div>
            <Notice v-else-if="items !== undefined" tone="success">{{ t(`sandbox.dataProtection.nothingToChange`) }}</Notice>

            <RowGroup v-if="plan.more.length > 0" :label="t(`sandbox.dataProtection.more`)">
                <template #info>
                    <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.dataProtection.more`) })">
                        <span class="block text-xs text-content">{{ t(`sandbox.dataProtection.moreHint`) }}</span>
                    </InfoHint>
                </template>
                <Row v-for="entry in plan.more" :key="entry.measure.id" indent>
                    <template #title><HintedTitle :title="nameOf(entry.measure)">{{ whatOf(entry.measure) }}</HintedTitle></template>
                    <template #control>
                        <div class="flex items-center gap-2">
                            <StatusBadge :variant="STATUS_TONE[entry.measure.status]" dot :label="statusOf(entry.measure)" />
                            <Button v-if="MEASURE_LINKS.has(entry.measure.id)" :as="RouterLink" :to="MEASURE_LINKS.get(entry.measure.id)" size="small" tier="quiet" tone="accent">
                                {{ t(`sandbox.dataProtection.change`) }}
                            </Button>
                        </div>
                    </template>
                    <template v-if="entry.unavailable.length > 0" #below>
                        <p v-for="item in entry.unavailable" :key="item.id" class="text-xs text-muted">{{ reasonOf(item) }}</p>
                    </template>
                </Row>
            </RowGroup>

            <RowGroup v-if="plan.inPlace.length > 0" :label="t(`sandbox.dataProtection.inPlace`)">
                <template v-if="showInPlace">
                    <Row v-for="measure in plan.inPlace" :key="measure.id">
                        <template #title><HintedTitle :title="nameOf(measure)">{{ whatOf(measure) }}</HintedTitle></template>
                        <template #control>
                            <div class="flex items-center gap-2">
                                <StatusBadge :variant="STATUS_TONE[measure.status]" dot :label="statusOf(measure)" />
                                <Button v-if="MEASURE_LINKS.has(measure.id)" :as="RouterLink" :to="MEASURE_LINKS.get(measure.id)" size="small" tier="quiet" tone="accent">
                                    {{ t(`sandbox.dataProtection.change`) }}
                                </Button>
                            </div>
                        </template>
                    </Row>
                </template>
                <RowNote>
                    <button type="button" :class="ui.textButton()" :aria-expanded="showInPlace" @click="showInPlace = !showInPlace">
                        {{ showInPlace ? t(`sandbox.dataProtection.hideInPlace`) : t(`sandbox.dataProtection.showInPlace`) }}
                    </button>
                </RowNote>
            </RowGroup>
        </template>

        <ConfirmDialog
            :open="confirming"
            :header="t(`sandbox.dataProtection.confirmHeader`)"
            :description="t(`sandbox.dataProtection.confirmDescription`)"
            :confirm-label="t(`sandbox.dataProtection.apply`, { count: pickedItems.length }, pickedItems.length)"
            :destructive="false"
            :items="pickedItems"
            size="md"
            @cancel="confirming = false"
            @confirm="applyPicked"
        >
            <template #item="{ item }">{{ presetLabel(item) }}: {{ presetValue(item, item.current) }} → {{ presetValue(item, item.proposed) }}</template>
        </ConfirmDialog>
    </div>
</template>
