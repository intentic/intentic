<script setup lang="ts">
import { countBadgePlate, countBadgeText, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useTemplateRef } from "vue";

// The phone's Chat | Changes switch, small enough to ride the agent screen's header instead of standing as a row of tabs
// under it. Two segments, a glyph each, and a thumb the pager slides along with the pages (SwipePages' follower), so the
// switch is also where the reader sees a swipe land. The Changes segment IS the count of what is still to land, on the
// same plate every count in the app wears; with nothing to land it falls back to a quiet glyph.
//
// Each segment is the header's own glyph button at a thumb's size (`xl`, 40px, as the session menu beside it), round,
// with `mx-0.5` either side, so the segments step 44px apart: the thumb's width, which is how far the pager moves it.
// The margin is also what keeps the two coarse-pointer targets (44px each) from reaching over each other's glyph. What is selected is said by the
// thumb alone, never by the button's `on` fill, which would jump while the thumb slides: the selected segment's ink, and
// a hover that leaves the thumb showing, ride `aria-selected` instead.

const t = useT();

const { pending, idPrefix } = defineProps<{
    /** Files still to land. */
    pending: number;
    /** The pages' id prefix (SwipePages), for `aria-controls`. */
    idPrefix: string;
}>();

const page = defineModel<`chat` | `changes`>({ required: true });

const thumb = useTemplateRef<HTMLElement>(`thumb`);
defineExpose({ thumb });
</script>

<template>
    <!-- Track and thumb are the stretch SegmentedControl's (canvas well, pill-on plate), at a header's size. -->
    <!-- allow(substitutes): the pager moves this thumb mid-swipe (SwipePages' follower), which <SegmentedControl>'s own thumb cannot follow -->
    <div role="tablist" :aria-label="t(`agents.agentDetail.pages`)" class="relative inline-flex shrink-0 items-center rounded-full border border-line bg-canvas p-0.5">
        <!-- Moved by the pager, never by a class: its place is the pages' place, mid-swipe included. -->
        <span ref="thumb" class="ui-pill-on pointer-events-none absolute left-0.5 top-0.5 h-10 w-11 rounded-full" aria-hidden="true"></span>
        <button
            type="button"
            role="tab"
            :aria-selected="page === `chat`"
            :aria-controls="`${idPrefix}-chat`"
            :aria-label="t(`shared.chat`)"
            :class="ui.iconButton({ size: `xl`, round: true }, `relative mx-0.5`)"
            class="aria-selected:text-content aria-selected:hover:bg-transparent aria-selected:active:bg-transparent"
            @click="page = `chat`"
        >
            <Icon name="comments" class="text-sm" aria-hidden="true" />
        </button>
        <button
            type="button"
            role="tab"
            :aria-selected="page === `changes`"
            :aria-controls="`${idPrefix}-changes`"
            :aria-label="pending > 0 ? `${t(`shared.changes`)} · ${t(`agents.agentDetail.toLand`, { count: pending })}` : t(`shared.changes`)"
            :class="ui.iconButton({ size: `xl`, round: true }, `relative mx-0.5`)"
            class="aria-selected:text-content aria-selected:hover:bg-transparent aria-selected:active:bg-transparent"
            @click="page = `changes`"
        >
            <span
                v-if="pending > 0"
                class="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-semibold leading-none tabular-nums"
                :class="countBadgePlate()"
                aria-hidden="true"
                >{{ countBadgeText(pending) }}</span
            >
            <Icon v-else name="file-edit" class="text-sm" aria-hidden="true" />
        </button>
    </div>
</template>
