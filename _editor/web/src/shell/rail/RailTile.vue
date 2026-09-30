<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { RouterLink } from "vue-router";
import ViewBadgeChip from "../../core-views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../core-views/viewBadge";
import RailIcon from "./RailIcon.vue";
import TileMark from "./TileMark.vue";

// ONE TILE OF THE RAIL, as a link: the section's glyph, its badge in the top corner, and the spinning mark in the bottom
// one while work runs behind it. The sandbox shell draws its tiles inline (ShellDesktop.vue); a desktop window on a local
// folder draws its own through this (local/LocalShell.vue), so the two rails carry the same marks the same way.

const { badge, active } = defineProps<{
    section: string;
    to: string;
    // The tile's whole name, badge included: its accessible name and its hover.
    label: string;
    badge?: ViewBadge | undefined;
    active: boolean;
}>();
</script>

<template>
    <RouterLink
        :to="to"
        class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
        :class="{ 'bg-primary-600/15 text-link': active }"
        :aria-label="label"
        v-tooltip.right="label"
    >
        <RailIcon :section="section" :label="label" class="icon-rail-glyph" />
        <ViewBadgeChip :badge="badge" class="icon-rail-mark absolute right-0.5 top-0.5" />
        <TileMark v-if="badge?.running !== undefined" name="spinner" spin :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]" />
    </RouterLink>
</template>
