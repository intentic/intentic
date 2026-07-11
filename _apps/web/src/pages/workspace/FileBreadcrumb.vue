<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { computed } from "vue";
import { viewersOfPath } from "../../composables/usePresence";
import PresenceAvatars from "../../layout/PresenceAvatars.vue";
import { formatBytes } from "./format";

/* The context bar above the open file: the root-relative path as breadcrumb segments, with the file size in a
 * tooltip on the last one. The trailing slot hosts contextual actions (FileViewer puts its edit controls there). */

const { path, meta } = defineProps<{ path: string; meta?: WorkspaceTreeEntry }>();

const segments = computed(() => path.split(`/`));
// Empty when there's no size — PrimeVue's tooltip directive unbinds on a falsy value, so no tooltip shows.
const sizeLabel = computed(() => formatBytes(meta?.size));
</script>

<template>
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-card px-3">
        <div class="scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap font-mono text-2xs text-subtle">
            <template v-for="(seg, index) in segments" :key="index">
                <span v-if="index === segments.length - 1" class="font-medium text-content" v-tooltip.bottom="sizeLabel">{{ seg }}</span>
                <template v-else>
                    <span>{{ seg }}</span>
                    <Icon name="angle-right" class="text-[0.55rem] opacity-60" />
                </template>
            </template>
        </div>
        <!-- Members looking at the same file as you, live. -->
        <PresenceAvatars :viewers="viewersOfPath(path)" label="also viewing this file" />
        <slot />
    </div>
</template>
