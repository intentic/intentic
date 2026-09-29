<!-- What a hub row says about its section without being opened: a run it walked away from, then its own chip. -->
<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { RUNNING_MARK_CLASS } from "../../core-views/viewBadge";
import ViewBadgeChip from "../../core-views/ViewBadgeChip.vue";

// One body for both of the hub's indexes, the desktop rail's rows and a phone's drill-down list, so a section's news
// reads the same whichever of them is on screen.
defineProps<{ badge: ViewBadge }>();
</script>

<template>
    <!-- Work in flight behind the section, in the rail tiles' own mark and ink: a hub mounts one section at a time, so this
         is all that is left on screen of a run the reader walked away from. The sentence rides the tooltip and the
         reader's screen reader — a 14rem row has no width to spend on it. -->
    <span v-if="badge.running !== undefined" class="inline-flex items-center" :class="RUNNING_MARK_CLASS" v-tooltip.right="badge.running">
        <Icon name="spinner" spin aria-hidden="true" />
        <span class="sr-only">{{ badge.running }}</span>
    </span>
    <ViewBadgeChip :badge="badge" class="text-2xs" />
</template>
