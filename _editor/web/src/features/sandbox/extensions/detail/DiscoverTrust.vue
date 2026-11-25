<script setup lang="ts">
import { Button, InfoHint, Row, RowGroup, type ButtonTier } from "@intentic/ui";
import { computed } from "vue";
import type { DiscoverListing } from "../../../../models/sandbox/discoverListing";
import { useT } from "@intentic/ui/i18n";
import { trustChecksOf } from "./trustChecks";

// What installing a listing would trust, split by whether it holds: what was checked, then what nothing covers. The two
// gaps a reader has to weigh stand apart instead of hiding among six bullets, and the one thing a reader can do about
// the first gap (have their own agent read the code) sits on that line. Each line's run id and longer account wait
// behind its (i).

const t = useT();

const { listing, readTier } = defineProps<{
    listing: DiscoverListing;
    /** The agent read's tier on the human-review line; absent where there is no commit to read. */
    readTier?: ButtonTier | undefined;
}>();

const emit = defineEmits<{ audit: [] }>();

const checks = computed(() => trustChecksOf(listing));
const held = computed(() => checks.value.filter((check) => check.passed));
const gaps = computed(() => checks.value.filter((check) => !check.passed));
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup v-if="held.length > 0" id="listing-trust" :label="t(`sandbox.discoverDetail.checked`)">
            <Row v-for="check in held" :key="check.id" :icon="check.icon" tone="success" :title="check.title" :description="check.detail">
                <template v-if="check.why" #meta>
                    <InfoHint :label="check.title"
                        ><span class="block text-xs text-content">{{ check.why }}</span></InfoHint
                    >
                </template>
                <template v-if="check.id === `human` && readTier" #control>
                    <Button size="small" :tier="readTier" :label="t(`sandbox.discoverDetail.agentRead`)" @click="emit(`audit`)">
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </template>
            </Row>
        </RowGroup>

        <RowGroup :id="held.length > 0 ? undefined : `listing-trust`" :label="t(`sandbox.discoverDetail.notCovered`)" tone="warning">
            <Row v-for="check in gaps" :key="check.id" :icon="check.icon" tone="warning" :title="check.title" :description="check.detail">
                <template v-if="check.why" #meta>
                    <InfoHint :label="check.title"
                        ><span class="block text-xs text-content">{{ check.why }}</span></InfoHint
                    >
                </template>
                <template v-if="check.id === `human` && readTier" #control>
                    <Button size="small" :tier="readTier" :label="t(`sandbox.discoverDetail.agentRead`)" @click="emit(`audit`)">
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
