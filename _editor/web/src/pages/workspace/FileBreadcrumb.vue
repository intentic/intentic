<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { computed, inject } from "vue";
import { viewersOfPath } from "../../composables/usePresence";
import PresenceAvatars from "../../presence/PresenceAvatars.vue";
import { formatBytes } from "@intentic/ui";
import { CONTEXT_TARGET, HOISTED_CONTEXT, VIEWER_ACTIONS_TARGET } from "./viewerChrome";

/* The open file's context: where it sits, who else is reading it, and whatever its viewer and the host want to
 * offer about it. The trailing slot hosts the host's actions (FileViewer puts its edit controls there); the
 * viewer's own controls arrive by teleport (see viewerChrome).
 *
 * IT IS A BAND ONLY WHERE NOTHING ELSE WILL CARRY IT. Hoisted into a view's existing bar (the desktop tab row)
 * it is a run of segments on that row; standalone (the phone, which has no tab strip) it draws the bar it
 * always drew.
 *
 * AND HOISTED, IT DROPS THE FILENAME. The tab two centimetres to its left already says `across-sandboxes-
 * design.md`; repeating it was the clearest thing wrong with the old stack, and the folders are the half that
 * was actually adding something. The whole path is still one hover away, with the file's size, which is where
 * the last segment's tooltip went.
 *
 * It also CLIPS rather than scrolls up there. A scrollbar is a promise that the rest is worth going to get, and
 * in a 36px bar shared with the tab strip it is three pixels of furniture under a path whose full text is
 * already in the tooltip. Standalone it keeps the scroller: that bar has nothing else in it, and on a phone
 * dragging the path is the only way to read the end of a deep one. */

const { path, meta } = defineProps<{ path: string; meta?: WorkspaceTreeEntry }>();

const hoisted = inject(HOISTED_CONTEXT, false);

const segments = computed(() => path.split(`/`));
// Hoisted: the folders alone, and nothing at all for a file at the root, where there is no folder context to
// give and a lone `›` would be punctuation pretending to be information.
const crumbs = computed(() => (hoisted ? segments.value.slice(0, -1) : segments.value));
// Empty when there's no size: PrimeVue's tooltip directive unbinds on a falsy value, so no tooltip shows.
const sizeLabel = computed(() => formatBytes(meta?.size));
const fullTitle = computed(() => (sizeLabel.value === `` ? path : `${path} · ${sizeLabel.value}`));
</script>

<template>
    <Teleport defer :to="`#${CONTEXT_TARGET}`" :disabled="!hoisted">
        <div :class="hoisted ? `flex min-w-0 items-center gap-2` : `flex h-8 shrink-0 items-center gap-2 border-b border-line bg-card px-3`">
            <div
                v-if="crumbs.length > 0"
                class="flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-2xs text-subtle"
                :class="hoisted ? `max-w-56 overflow-hidden` : `scrollbar-thin flex-1 overflow-x-auto`"
                v-tooltip.bottom="fullTitle"
            >
                <template v-for="(seg, index) in crumbs" :key="index">
                    <!-- Standalone, the last segment IS the file and wears the weight. Hoisted, every segment
                         is a folder, so none of them does: the emphasis belongs on the tab. -->
                    <span v-if="!hoisted && index === crumbs.length - 1" class="font-medium text-content">{{ seg }}</span>
                    <template v-else>
                        <span>{{ seg }}</span>
                        <Icon v-if="index < crumbs.length - 1" name="angle-right" class="text-[0.55rem] opacity-60" />
                    </template>
                </template>
            </div>
            <!-- Members looking at the same file as you, live. -->
            <PresenceAvatars :members="viewersOfPath(path)" label="also viewing this file" />
            <!-- The viewer's own controls, teleported in rather than opening a toolbar under this one. -->
            <div :id="VIEWER_ACTIONS_TARGET" class="flex shrink-0 items-center gap-1"></div>
            <slot />
        </div>
    </Teleport>
</template>
