<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { computed, inject } from "vue";
import { viewersOfPath } from "../../../shell/presence/usePresence";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import { formatBytes } from "@intentic/ui";
import { CHROME_SCOPE, contextTarget, HOISTED_CONTEXT, viewerActionsTarget } from "../files/viewerChrome";

// Open file's path, presence avatars, and the host's/viewer's own actions (via teleport); drawn as its own bar
// only where nothing else carries it (hoisted into an existing tab row otherwise).
// Hoisted, it drops the filename (the tab already shows it) and clips instead of scrolling; standalone it keeps both.

const { path, meta } = defineProps<{ path: string; meta?: WorkspaceTreeEntry }>();

const hoisted = inject(HOISTED_CONTEXT, false);
// Which pane's bar this belongs to; the phone provides none and never teleports.
const scope = inject(CHROME_SCOPE, `main`);

const segments = computed(() => path.split(`/`));
// Hoisted shows folders only, nothing for a root-level file, where a lone `›` would say nothing.
const crumbs = computed(() => (hoisted ? segments.value.slice(0, -1) : segments.value));
// Empty when there's no size, so PrimeVue's tooltip directive unbinds rather than showing a blank tooltip.
const sizeLabel = computed(() => formatBytes(meta?.size));
const fullTitle = computed(() => (sizeLabel.value === `` ? path : `${path} · ${sizeLabel.value}`));
</script>

<template>
    <Teleport defer :to="`#${contextTarget(scope)}`" :disabled="!hoisted">
        <div :class="hoisted ? `flex min-w-0 items-center gap-2` : `flex h-8 shrink-0 items-center gap-2 border-b border-line bg-card px-3`">
            <div
                v-if="crumbs.length > 0"
                class="flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-2xs text-subtle"
                :class="hoisted ? `max-w-56 overflow-hidden` : `scrollbar-thin flex-1 overflow-x-auto`"
                v-tooltip.bottom="fullTitle"
            >
                <template v-for="(seg, index) in crumbs" :key="index">
                    <!-- Standalone, the last segment is the file and gets the emphasis; hoisted, every segment is just a folder. -->
                    <span v-if="!hoisted && index === crumbs.length - 1" class="font-medium text-content">{{ seg }}</span>
                    <template v-else>
                        <span>{{ seg }}</span>
                        <Icon v-if="index < crumbs.length - 1" name="angle-right" class="text-[0.55rem] opacity-60" />
                    </template>
                </template>
            </div>
            <!-- Members looking at the same file as you, live. -->
            <PresenceAvatars :members="viewersOfPath(path)" label="also viewing this file" />
            <!-- Viewer's own controls, teleported in here. -->
            <div :id="viewerActionsTarget(scope)" class="flex shrink-0 items-center gap-1"></div>
            <slot />
        </div>
    </Teleport>
</template>
