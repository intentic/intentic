<script setup lang="ts">
import { EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import StandingGrants from "../StandingGrants.vue";
import { useStandingGrants } from "../useStandingGrants";

// ACCESS ▸ ALLOWED: what conversations were allowed past their persona or area, and the yeses that name no conversation,
// each taken back here. The Needs you inbox's Allowed tab until 2026-10-12, then the foot of the one Access page, where a
// yes nobody was looking for sat under nine other groups. A part of its own now, with its count on the tab, so a standing
// exception is seen without scrolling for it.

const t = useT();
const { conversations, ownerWide, unreadable } = useStandingGrants();
// The list draws nothing while nothing stands; the part says so instead of opening blank.
const empty = computed(() => conversations.value.length === 0 && ownerWide.value.length === 0 && unreadable.value.length === 0);
</script>

<template>
    <div class="flex flex-col gap-6">
        <EmptyState v-if="empty" icon="shield" :title="t(`sandbox.sandboxAccess.allowedEmpty`)" :line="t(`sandbox.sandboxAccess.allowedEmptyLine`)" class="py-10" />
        <StandingGrants v-else />
    </div>
</template>
