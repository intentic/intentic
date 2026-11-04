<script setup lang="ts">
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { CARD_DISK_MARK_BYTES, checkoutParts, checkoutTotal } from "../../../sandbox/overview/storage/checkoutsView";
import { checkoutPartLabel } from "../../../sandbox/overview/storage/checkoutLabels";
import { STORAGE_ANCHOR } from "../../../sandbox/overview/storage/storageAnchor";
import { useCheckoutSizes } from "../../../sandbox/overview/storage/useCheckoutSizes";
import { here, page } from "../../../../lib/routes/links";

// How much disk this conversation's checkout held at the last scan, once that is worth a look (a Rust target alone is
// 10-30 GB), linking to the Disk card where it can be freed. This sandbox's cards only: the scan is this daemon's.

const t = useT();
const props = defineProps<{ agent: FleetAgent }>();
const sizes = useCheckoutSizes();
const row = computed(() => (props.agent.sandboxId === undefined ? sizes.value.get(props.agent.id) : undefined));
const total = computed(() => (row.value === undefined ? 0 : checkoutTotal(row.value)));
// One line per part under when it was measured, for the tooltip's `lines` form.
const detail = computed(() => [t(`agents.cardDiskUse.lastScan`), ...(row.value === undefined ? [] : checkoutParts(row.value).map(checkoutPartLabel))].join(`\n`));
</script>

<template>
    <RouterLink
        v-if="total >= CARD_DISK_MARK_BYTES"
        :to="here(page.sandboxSettings(undefined, { hash: STORAGE_ANCHOR }))"
        class="flex min-w-0 items-center gap-1.5 self-start text-2xs text-muted hover:text-content"
        data-disk-use
        v-tooltip.top.lines="detail"
        @click.stop
    >
        <Icon name="database" class="shrink-0 text-2xs" />
        <span class="tabular-nums">{{ t(`agents.cardDiskUse.onDisk`, { bytes: formatBytes(total) }) }}</span>
    </RouterLink>
</template>
