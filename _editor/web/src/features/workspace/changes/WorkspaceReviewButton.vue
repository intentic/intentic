<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { draftWorkspaceReview } from "../../../models/fleet/reviewAsk";

// The reader's uncommitted work, reviewed by an agent before it is committed: the ask goes into a new chat's composer,
// running in the shared tree where that work is (reviewAsk.ts). The bar's own glyph-button classes come from the bar.

const t = useT();
</script>

<template>
    <button
        type="button"
        @click="draftWorkspaceReview"
        v-tooltip.top="t(`workspace.reviewPanel.reviewChanges`)"
        :aria-label="t(`workspace.reviewPanel.reviewChanges`)"
    >
        <Icon name="list-check" class="text-2xs" />
    </button>
</template>
