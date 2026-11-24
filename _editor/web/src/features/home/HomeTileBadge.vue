<!-- One Home tile's badge: what the sandbox the tile stands in (`<InSandbox>`) holds for its reader, or that it was made
     while its reader was elsewhere and is ready. Its attributes (a size, a place on the tile) go to the chip. -->
<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxScope } from "../../client/sandbox/scope/useSandboxScope";
import { useAttentionMine } from "../../models/home/useAttentionMine";
import ViewBadgeChip from "../../workbench/views/ViewBadgeChip.vue";
import { readySandboxes } from "./newSandbox/newSandbox";

const t = useT();
const scope = useSandboxScope();
const { query } = useAttentionMine();

const badge = computed((): ViewBadge | undefined => {
    const id = scope.id.value;
    const count = query.data.value?.needsYou ?? 0;
    if (count > 0) {
        return { count, tooltip: t(`home.sandboxAttention`, { name: scope.summary.value?.name ?? ``, count }) };
    }
    // Made while its reader was in another sandbox's chat: it says it is ready until it is opened.
    return id !== undefined && readySandboxes.value.has(id) ? { mark: `check`, tone: `info` } : undefined;
});
</script>

<template>
    <ViewBadgeChip :badge="badge" />
</template>
