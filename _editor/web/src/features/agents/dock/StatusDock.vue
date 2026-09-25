<script setup lang="ts">
import { ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId } from "vue";
import { DOCK_DEFAULT_HEIGHT, DOCK_MAX_HEIGHT, DOCK_MIN_HEIGHT, type DockSegment } from "./dockState";

// ONE WAY TO KEEP AN EYE ON THINGS. A host's foot carries a status bar of segments, each saying at rest what a reader
// most needs from it (what is running, what is red, how full the box is). Pressing one opens its panel docked above
// the bar, in the layout rather than over it: the host's content moves up instead of being covered, and nothing but
// the reader closes it again (its segment, its ×, or Escape inside it). No click elsewhere does, because a panel is
// opened to be watched. The segments work as tabs: one panel at a time, with the whole width, and pressing another
// segment swaps it in. The reader sets its height on the seam above it, and the host remembers both (dockState.ts).
// The dock is opaque: a skin's backdrop (Sanctum's temples along the window's foot) must not show through the bar.
//
// Slots, per segment id: `summary-<id>` (the bar's words, inside the toggle), `aside-<id>` (a bar action beside the
// toggle, never inside it), `actions-<id>` (the panel header's own controls), `panel-<id>` (the panel's body).

const t = useT();

const props = defineProps<{
    segments: readonly DockSegment[];
    // What the dock is, for a screen reader.
    label: string;
}>();

const open = defineModel<string | undefined>(`open`, { required: true });
const height = defineModel<number>(`height`, { required: true });

const uid = useId();
const panelId = (id: string): string => `${uid}-panel-${id}`;
const headingId = (id: string): string => `${uid}-heading-${id}`;
const segmentId = (id: string): string => `${uid}-segment-${id}`;

// The bar's order: the leading segments, then the ones at the far end.
const ordered = computed(() => [...props.segments.filter((segment) => segment.end !== true), ...props.segments.filter((segment) => segment.end === true)]);
const firstEnd = computed(() => ordered.value.find((segment) => segment.end === true)?.id);
const isOpen = (id: string): boolean => open.value === id;
// A segment the host no longer draws (metrics turned off) stays in `open`, so it comes back as it was left.
const shown = computed(() => ordered.value.find((segment) => isOpen(segment.id)));

const toggle = (id: string): void => {
    open.value = isOpen(id) ? undefined : id;
};

// Closing from inside the panel hands focus back to the segment that opened it, so a keyboard reader is not dropped.
const close = (id: string): void => {
    open.value = undefined;
    void nextTick(() => document.getElementById(segmentId(id))?.focus());
};
</script>

<template>
    <div role="region" :aria-label="label" class="flex shrink-0 flex-col border-t border-line bg-canvas text-2xs">
        <div v-if="shown !== undefined" data-dock-panels class="relative flex max-h-[50vh] min-h-0" :style="{ height: `${height}px` }">
            <ResizeSeam
                v-model="height"
                axis="y"
                pane="after"
                place="edge"
                :min="DOCK_MIN_HEIGHT"
                :max="DOCK_MAX_HEIGHT"
                :reset="DOCK_DEFAULT_HEIGHT"
                :title="t(`shared.dragToResizeDouble`)"
            />
            <section
                :id="panelId(shown.id)"
                :key="shown.id"
                :data-panel="shown.id"
                :aria-labelledby="headingId(shown.id)"
                class="flex min-w-0 flex-1 flex-col"
                @keydown.esc.stop="close(shown.id)"
            >
                <header class="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3">
                    <Icon :name="shown.icon" class="shrink-0 text-2xs text-subtle" />
                    <h3 :id="headingId(shown.id)" class="min-w-0 truncate text-2xs font-medium uppercase tracking-wide text-muted">
                        {{ shown.title }}
                    </h3>
                    <Icon
                        v-if="shown.hint !== undefined"
                        name="info-circle"
                        tabindex="0"
                        role="note"
                        :aria-label="shown.hint"
                        v-tooltip.top="shown.hint"
                        class="shrink-0 cursor-help text-2xs text-subtle hover:text-muted"
                    />
                    <div class="ml-auto flex shrink-0 items-center gap-1">
                        <slot :name="`actions-${shown.id}`" />
                        <button
                            type="button"
                            :class="ui.iconButton(`hover:bg-content/10`)"
                            :aria-label="t(`agents.dock.close`, { title: shown.title })"
                            v-tooltip.top="t(`agents.dock.close`, { title: shown.title })"
                            @click="close(shown.id)"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </div>
                </header>
                <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                    <slot :name="`panel-${shown.id}`" />
                </div>
            </section>
        </div>
        <div class="flex min-h-7 flex-wrap items-center gap-x-1 gap-y-0.5 px-1.5 py-0.5" :class="shown !== undefined ? `border-t border-line-subtle` : ``">
            <template v-for="segment in ordered" :key="segment.id">
                <button
                    :id="segmentId(segment.id)"
                    type="button"
                    :data-segment="segment.id"
                    :aria-expanded="isOpen(segment.id)"
                    :aria-controls="isOpen(segment.id) ? panelId(segment.id) : undefined"
                    class="flex h-6 min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 text-left transition-colors"
                    :class="[
                        isOpen(segment.id) ? `bg-content/8 text-content` : `text-muted hover:bg-content/5 hover:text-content`,
                        segment.id === firstEnd ? `ml-auto` : ``,
                    ]"
                    v-tooltip.top="isOpen(segment.id) ? t(`agents.dock.hide`, { title: segment.title }) : t(`agents.dock.show`, { title: segment.title })"
                    @click="toggle(segment.id)"
                >
                    <slot :name="`summary-${segment.id}`" />
                    <Icon :name="isOpen(segment.id) ? `chevron-down` : `chevron-up`" class="shrink-0 text-2xs text-subtle" />
                </button>
                <slot :name="`aside-${segment.id}`" />
            </template>
        </div>
    </div>
</template>
