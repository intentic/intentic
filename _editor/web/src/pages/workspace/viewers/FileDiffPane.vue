<script setup lang="ts">
import type { PartialFileDiff } from "@intentic/sandbox-contract";
import { formatBytes } from "@intentic/ui";
import { computed } from "vue";
import type { LineStat } from "../../../composables/workspace/codeStat";
import { rendersAsBytes } from "../fileType";
import BinaryDiffView from "./BinaryDiffView.vue";
import { patchedSides } from "./diffPatch";
import DiffView from "./DiffView.vue";

/* ONE FILE'S DIFF, whichever of the four shapes a diff can arrive in. Every review surface in the product
 * renders this same fork, the Changes tab, the phone, an agent's review, and each used to spell it out for
 * itself, which is how the three drifted: the same file could open as a picture in one and as a sentence about
 * its size in another. The loading state stays with the host (each has its own), the CONTENT does not.
 *
 * The four shapes, in the order they have to be decided:
 *
 *   BYTES.    No text to diff is not the same as nothing to see: a .png renders as its two sides.
 *   PARTIAL.  Too big to send whole, so the daemon sent the changed regions as a patch instead. Rebuilt into
 *             two sides and rendered as an ordinary diff, with the file's own line numbers, under a bar that
 *             says what is on screen and what isn't.
 *   NOTHING.  Partial, but with no patch to show: a change too large even to render as one. The sizes are all
 *             there is to say, so the bar says them and there is nothing underneath it.
 *   TEXT.     The ordinary case, both whole sides.
 */
const { path, before, after, binary, partial, beforeRaw, afterRaw } = defineProps<{
    path: string;
    before?: string;
    after?: string;
    binary?: boolean;
    // Set when the file was too big to ship as two sides: what came instead. See PartialFileDiff / diffPatch.
    partial?: PartialFileDiff;
    // Where the two sides' BYTES live, for a diff the response could only flag as binary (daemon /diff/raw).
    beforeRaw?: string;
    afterRaw?: string;
}>();
// The pane's own reading of what changed, code-only, for the toolbar above it. Forwarded from whichever viewer
// is showing: a partial diff answers `undefined` there, because what it holds is an excerpt and counting it
// would describe the excerpt rather than the change (DiffView owns that rule; it is the one that knows).
const emit = defineEmits<{ stat: [LineStat | undefined] }>();

// The patch, unpicked into two sides plus the file line each of their lines came from. undefined when the
// daemon had no patch to send, or sent one with no regions in it.
const patched = computed(() => (partial?.patch === undefined ? undefined : patchedSides(partial.patch, partial.more === true)));

// How big the thing we are not showing is, in the shape the change has: a size per side that exists, so an
// added file reads as one number rather than as "0 B → 4.1 MB".
const size = computed(() => {
    const from = partial?.beforeBytes;
    const to = partial?.afterBytes;
    if (from !== undefined && to !== undefined) {
        return from === to ? formatBytes(to) : `${formatBytes(from)} → ${formatBytes(to)}`;
    }
    return formatBytes(to ?? from ?? 0);
});

/* The one line above the panes, and it has to answer two questions at once: why this is not the whole file, and
 * whether what IS here is all of the change. The second matters more than it looks: a reader who assumes they
 * have seen every change, when they have seen the first twenty, approves work they never read.
 *
 * A file with only one side (added, deleted) is its own sentence. Its "change" is the whole file, so counting
 * regions there would say "1 changed region" about six megabytes of new code, which is true and useless. */
const note = computed(() => {
    const regions = patched.value?.regions;
    if (regions === undefined) {
        return `${size.value} — too large to diff in the browser, and the change too large to send as a patch.`;
    }
    if (partial?.beforeBytes === undefined || partial.afterBytes === undefined) {
        return partial?.more === true ? `${size.value} — the start of it; too large to show whole.` : `${size.value} — the whole file.`;
    }
    const counted = `${regions} changed ${regions === 1 ? `region` : `regions`}`;
    return partial.more === true
        ? `${size.value} — the first ${counted}; more follow further down the file.`
        : `${size.value} — ${counted}; the rest of the file is unchanged.`;
});
</script>

<template>
    <BinaryDiffView v-if="rendersAsBytes(path, binary)" :path="path" :before="beforeRaw" :after="afterRaw" />
    <div v-else-if="partial !== undefined" class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
            <Icon :name="patched ? `compress` : `info-circle`" class="shrink-0 text-[0.7rem]" />
            <span class="min-w-0 truncate" v-tooltip.bottom.overflow="note">{{ note }}</span>
        </div>
        <div v-if="patched" class="min-h-0 flex-1">
            <DiffView
                :before="patched.before"
                :after="patched.after"
                :path="path"
                :lines="{ before: patched.beforeLines, after: patched.afterLines }"
                @stat="(stat) => emit(`stat`, stat)"
            />
        </div>
    </div>
    <DiffView v-else :before="before" :after="after" :path="path" @stat="(stat) => emit(`stat`, stat)" />
</template>
