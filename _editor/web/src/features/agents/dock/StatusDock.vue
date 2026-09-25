<script setup lang="ts">
import { ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId } from "vue";
import { DOCK_DEFAULT_HEIGHT, DOCK_MAX_HEIGHT, DOCK_MIN_HEIGHT, type DockSegment } from "./dockState";

// ONE WAY TO KEEP AN EYE ON THINGS. A host's foot carries a status bar of segments, each saying at rest what a reader
// most needs from it (what is running, what is red, how full the box is). Pressing one opens its panel docked above
// the bar, in the layout rather than over it: the host's content moves up instead of being covered, and nothing but
// the reader closes it again (its segment, its ×, or Escape inside it). No click elsewhere does, because a panel is
// opened to be watched. Several may be open side by side; the reader sets their height on the seam above them, and the
// host remembers both (dockState.ts).
//
// Slots, per segment id: `summary-<id>` (the bar's words, inside the toggle), `aside-<id>` (a bar action beside the
// toggle, never inside it), `actions-<id>` (the panel header's own controls), `panel-<id>` (the panel's body).

const t = useT();

const props = defineProps<{
    segments: readonly DockSegment[];
    // What the dock is, for a screen reader.
    label: string;
}>();

const open = defineModel<readonly string[]>(`open`, { required: true });
const height = defineModel<number>(`height`, { required: true });

const uid = useId();
const panelId = (id: string): string => `${uid}-panel-${id}`;
const headingId = (id: string): string => `${uid}-heading-${id}`;
const segmentId = (id: string): string => `${uid}-segment-${id}`;

// The bar's order: the leading segments, then the ones at the far end. Panels open in the same order, so each sits
// over its own side of the bar.
const ordered = computed(() => [...props.segments.filter((segment) => segment.end !== true), ...props.segments.filter((segment) => segment.end === true)]);
const firstEnd = computed(() => ordered.value.find((segment) => segment.end === true)?.id);
const isOpen = (id: string): boolean => open.value.includes(id);
// A segment the host no longer draws (metrics turned off) keeps its place in `open`, so it comes back as it was left.
const shown = computed(() => ordered.value.filter((segment) => isOpen(segment.id)));

const toggle = (id: string): void => {
    open.value = isOpen(id) ? open.value.filter((other) => other !== id) : [...open.value, id];
};

// Closing from inside the panel hands focus back to the segment that opened it, so a keyboard reader is not dropped.
const close = (id: string): void => {
    open.value = open.value.filter((other) => other !== id);
    void nextTick(() => document.getElementById(segmentId(id))?.focus());
};
</script>

<template>
    <div role="region" :aria-label="label" class="flex shrink-0 flex-col border-t border-line text-2xs">
        <div v-if="shown.length > 0" data-dock-panels class="relative flex max-h-[50vh] min-h-0 bg-canvas" :style="{ height: `${height}px` }">
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
                v-for="(segment, index) in shown"
                :id="panelId(segment.id)"
                :key="segment.id"
                :data-panel="segment.id"
                :aria-labelledby="headingId(segment.id)"
                class="flex min-w-0 basis-0 flex-col"
                :class="index > 0 ? `border-l border-line-subtle` : ``"
                :style="{ flexGrow: segment.weight ?? 1 }"
                @keydown.esc.stop="close(segment.id)"
            >
                <header class="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3">
                    <Icon :name="segment.icon" class="shrink-0 text-2xs text-subtle" />
                    <h3 :id="headingId(segment.id)" class="min-w-0 truncate text-2xs font-medium uppercase tracking-wide text-muted">
                        {{ segment.title }}
                    </h3>
                    <Icon
                        v-if="segment.hint !== undefined"
                        name="info-circle"
                        tabindex="0"
                        role="note"
                        :aria-label="segment.hint"
                        v-tooltip.top="segment.hint"
                        class="shrink-0 cursor-help text-2xs text-subtle hover:text-muted"
                    />
                    <div class="ml-auto flex shrink-0 items-center gap-1">
                        <slot :name="`actions-${segment.id}`" />
                        <button
                            type="button"
                            :class="ui.iconButton(`hover:bg-content/10`)"
                            :aria-label="t(`agents.dock.close`, { title: segment.title })"
                            v-tooltip.top="t(`agents.dock.close`, { title: segment.title })"
                            @click="close(segment.id)"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </div>
                </header>
                <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                    <slot :name="`panel-${segment.id}`" />
                </div>
            </section>
        </div>
        <div class="flex min-h-7 flex-wrap items-center gap-x-1 gap-y-0.5 px-1.5 py-0.5" :class="shown.length > 0 ? `border-t border-line-subtle` : ``">
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
