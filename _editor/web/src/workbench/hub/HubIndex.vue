<!-- A hub's index as a phone reads it: every section as a full-width row in its group, each opening a page of its own. -->
<script setup lang="ts">
import { type NavGroup, Row, RowGroup } from "@intentic/ui";
import { sectionIcon } from "@intentic/ui/icons";
import type { RouteLocationRaw } from "vue-router";
import { badgeSpeaks } from "../views/viewBadge";
import type { HubTab } from "./hubNav";
import HubRowBadge from "./HubRowBadge.vue";

// The desktop rail's own groups, drawn the way every other list in the app is drawn (a labelled group of rows) rather
// than as the rail's 14rem column: on a phone the index IS the page, so a row gets the whole width and a thumb's
// height, and a section is a place you go to rather than a tab you flip.
defineProps<{
    groups: readonly NavGroup<HubTab>[];
    /** Where a row goes; the hub owns its addresses. */
    linkTo: (slug: string) => RouteLocationRaw;
}>();
</script>

<template>
    <nav class="flex flex-col gap-6">
        <RowGroup v-for="group in groups" :key="group.key" :label="group.label">
            <RouterLink v-for="tab in group.items" :key="tab.slug" :to="linkTo(tab.slug)" class="block">
                <Row as="div" interactive chevron :icon="sectionIcon(tab.slug, tab.icon)" :title="tab.label">
                    <!-- A fact about the section, so it rides the row's #meta cluster; tested out here because Row draws that slot only when it is filled. -->
                    <template v-if="tab.badge !== undefined && badgeSpeaks(tab.badge)" #meta>
                        <HubRowBadge :badge="tab.badge" />
                    </template>
                </Row>
            </RouterLink>
        </RowGroup>
    </nav>
</template>
