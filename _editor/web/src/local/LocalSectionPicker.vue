<!-- THIS COMPUTER'S BOOKMARK: where its sections go while its rail is unrolled onto every sandbox (LocalMasterRail.vue), at
     the rail's foot, as the workspace's rail puts a sandbox's away (shell/rail/HomeSectionPicker.vue). The section tiles
     fold into this one tile and fly back out of it when the rail folds (shell/rail/railMorph.ts, by `data-rail-holds`).
     It marks the section on screen; a pick shows that section, the rail staying unrolled. -->
<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { ResponsiveOverlay, type TooltipValue } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import RailIcon from "../shell/rail/RailIcon.vue";
import ViewBadgeChip from "../workbench/views/ViewBadgeChip.vue";

export interface LocalSection {
    readonly section: string;
    readonly to: string;
    readonly label: string;
    readonly badge?: ViewBadge;
}

const { sections, active } = defineProps<{ sections: readonly LocalSection[]; active: (to: string) => boolean }>();
const t = useT();
const router = useRouter();
const open = ref(false);
const anchor = ref<HTMLElement>();

const shown = computed(() => sections.find((section) => active(section.to)));
const label = computed(() => [t(`home.section.choose`), shown.value?.label].filter((part) => part !== undefined).join(` · `));
const tip = computed<TooltipValue>(() =>
    shown.value === undefined ? t(`home.section.choose`) : { title: t(`home.section.choose`), rows: [{ label: t(`home.section.view`), value: shown.value.label }] },
);

const choose = (section: LocalSection): void => {
    open.value = false;
    if (!active(section.to)) {
        void router.push(section.to);
    }
};
</script>

<template>
    <button
        ref="anchor"
        type="button"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal flex items-center justify-center rounded-lg"
        :class="[open ? `ui-row-select-on` : ``, shown !== undefined || open ? `text-link` : `text-muted hover:text-content`]"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-label="label"
        v-tooltip.right="open ? undefined : tip"
        data-rail-key="rail:sections"
        data-rail-holds="sections"
        @click="open = !open"
    >
        <Icon name="book" class="icon-rail-glyph" aria-hidden="true" />
    </button>
    <ResponsiveOverlay v-model="open" :anchor="anchor" side="right" cross="end" :header="t(`home.section.choose`)" panel-class="w-64 p-1">
        <div class="flex flex-col gap-0.5" role="list">
            <button
                v-for="section in sections"
                :key="section.to"
                type="button"
                role="listitem"
                class="ui-row-select ui-row-select-horizontal flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs"
                :class="active(section.to) ? `ui-row-select-on text-link` : `text-content`"
                :aria-current="active(section.to) ? `page` : undefined"
                @click="choose(section)"
            >
                <RailIcon :section="section.section" :label="section.label" class="shrink-0 text-base" />
                <span class="min-w-0 flex-1 truncate">{{ section.label }}</span>
                <ViewBadgeChip :badge="section.badge" class="shrink-0 text-2xs" />
            </button>
        </div>
    </ResponsiveOverlay>
</template>
