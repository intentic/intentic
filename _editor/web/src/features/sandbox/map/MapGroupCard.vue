<script setup lang="ts">
import { BrandMark, Icon, toneDot } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import MapNodeButton from "./MapNodeButton.vue";
import { GROUP_ICONS, groupLabel } from "./mapWords";
import { bundleId, type Focus, type Lighting } from "./reachLighting";
import type { MapGroup, MapNode, NodeTone, ReachHow } from "./reachModel";

// ONE KIND OF THING THE SANDBOX REACHES (its services, its accounts, its machines…), as a card on the map's right edge.
//
// Detailed, each row is a line's end, and a long group shows its first few and folds the rest behind one row, which still
// says how many of the folded ones the focus reaches, so a lit thing is never hidden without a trace.
//
// Compact, the whole group is one block: what it is, a few of its marks, how many there are, and a dot when one needs a
// look. One line reaches it. Under a focus it says how many of them the focus reaches and fills a meter by as much;
// pointing at it lights whoever reaches anything in it; a press opens it into its rows, and the header folds it back.

const t = useT();

// Past this, a detailed card folds: enough rows to read the group at a glance, few enough that six groups still fit a screen.
const FOLD_AT = 6;
const SHOWN_FOLDED = 4;
// How many marks a block shows before it says how many more.
const MARKS = 5;

const {
    group,
    lighting,
    pinned,
    expanded,
    compact = false,
} = defineProps<{
    group: MapGroup;
    lighting: Lighting | undefined;
    pinned: Focus | undefined;
    expanded: boolean;
    compact?: boolean;
}>();
const emit = defineEmits<{ point: [focus: Focus | undefined]; press: [focus: Focus]; toggle: [] }>();

const block = computed(() => compact && !expanded);
const folds = computed(() => !compact && group.nodes.length > FOLD_AT);
const shown = computed(() => (folds.value && !expanded ? group.nodes.slice(0, SHOWN_FOLDED) : group.nodes));
const hidden = computed(() => group.nodes.length - shown.value.length);
const litOf = (id: string): ReachHow | `self` | `related` | `off` | undefined => (lighting === undefined ? undefined : (lighting.nodes.get(id) ?? `off`));
const litCount = computed(() => group.nodes.filter((node) => lighting?.nodes.has(node.id) === true).length);
const hiddenLit = computed(() => group.nodes.slice(shown.value.length).filter((node) => lighting?.nodes.has(node.id) === true).length);
const focusOf = (node: MapNode): Focus => ({ kind: `node`, id: node.id });
const bundle = computed<Focus>(() => ({ kind: `node`, id: bundleId(group.key) }));

const marks = computed(() => group.nodes.slice(0, MARKS));
// The worst state among its members, so a folded block never hides that one of them is broken.
const TROUBLE = [`danger`, `warning`] as const satisfies readonly NodeTone[];
const trouble = computed(() => TROUBLE.find((tone) => group.nodes.some((node) => node.tone === tone)));
const count = computed(() => (lighting === undefined ? String(group.nodes.length) : t(`sandbox.sandboxMap.litOf`, { lit: litCount.value, total: group.nodes.length })));

// A block lights as one card: the focus itself, reached in part, or dark.
const blockEdge = computed(() => {
    if (lighting === undefined) {
        return `border-line-subtle bg-card hover:border-line`;
    }
    if (lighting.nodes.get(bundleId(group.key)) === `self`) {
        return `border-(--map-edge-strong) bg-(--map-wash) shadow-(--map-halo)`;
    }
    return litCount.value > 0 ? `border-(--map-edge) bg-card` : `border-line-subtle bg-card opacity-35`;
});
</script>

<template>
    <section
        :data-group="group.key"
        class="relative flex flex-col rounded-xl border transition-[opacity,border-color,box-shadow,background-color]"
        :class="block ? blockEdge : `gap-0.5 border-line-subtle bg-canvas p-1.5`"
    >
        <template v-if="block">
            <button
                type="button"
                :data-node="bundleId(group.key)"
                :aria-expanded="false"
                :title="t(`sandbox.sandboxMap.openGroup`)"
                class="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 pb-2.5 pt-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
                @pointerenter="emit(`point`, bundle)"
                @pointerleave="emit(`point`, undefined)"
                @focus="emit(`point`, bundle)"
                @blur="emit(`point`, undefined)"
                @click="emit(`toggle`)"
            >
                <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-overlay text-sm text-muted"><Icon :name="GROUP_ICONS[group.key]" /></span>
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="truncate text-sm font-medium text-content">{{ groupLabel(group.key) }}</span>
                    <span class="flex min-w-0 items-center gap-1.5 text-muted">
                        <BrandMark v-for="node in marks" :key="node.id" :size="13" :name="node.label" :logo="node.logo" :icon="node.icon" plain />
                        <span v-if="group.nodes.length > marks.length" class="text-3xs text-subtle">+{{ group.nodes.length - marks.length }}</span>
                    </span>
                </span>
                <span class="flex shrink-0 items-center gap-1.5">
                    <span v-if="trouble !== undefined" class="size-1.5 rounded-full" :class="toneDot(trouble)" />
                    <span class="text-xs tabular-nums" :class="lighting !== undefined && litCount > 0 ? `font-medium text-content` : `text-subtle`">{{ count }}</span>
                </span>
            </button>
            <!-- How much of the group the focus reaches, as a share: read at a glance where the count needs reading. -->
            <span v-if="lighting !== undefined" class="pointer-events-none absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full bg-line-subtle">
                <span class="block h-full rounded-full bg-(--map-ink) opacity-60 transition-[width]" :style="{ width: `${(100 * litCount) / group.nodes.length}%` }" />
            </span>
        </template>

        <template v-else>
            <component
                :is="compact ? `button` : `header`"
                :type="compact ? `button` : undefined"
                :aria-expanded="compact ? true : undefined"
                :title="compact ? t(`sandbox.sandboxMap.foldGroup`) : undefined"
                class="flex items-center gap-2 rounded-lg px-1.5 pb-1 pt-0.5 text-left text-xs text-muted"
                :class="compact ? `transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link` : ``"
                @click="compact && emit(`toggle`)"
            >
                <Icon :name="GROUP_ICONS[group.key]" class="shrink-0" />
                <h3 class="min-w-0 flex-1 truncate font-medium">{{ groupLabel(group.key) }}</h3>
                <span class="shrink-0 tabular-nums" :class="lighting === undefined ? `text-subtle` : litCount > 0 ? `text-content` : `text-faint`">{{ count }}</span>
                <Icon v-if="compact" name="chevron-up" class="shrink-0" />
            </component>
            <MapNodeButton
                v-for="node in shown"
                :key="node.id"
                :node
                variant="row"
                :lit="litOf(node.id)"
                :pinned="pinned?.id === node.id"
                @point="(on) => emit(`point`, on ? focusOf(node) : undefined)"
                @press="emit(`press`, focusOf(node))"
            />
            <button
                v-if="folds"
                type="button"
                :data-node="bundleId(group.key)"
                class="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1 text-left text-xs text-muted transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
                :aria-expanded="expanded"
                @click="emit(`toggle`)"
            >
                <Icon :name="expanded ? `chevron-up` : `chevron-down`" />
                <span class="min-w-0 flex-1 truncate">{{ expanded ? t(`sandbox.sandboxMap.fewer`) : t(`sandbox.sandboxMap.more`, { count: hidden }, hidden) }}</span>
                <span v-if="!expanded && hiddenLit > 0" class="shrink-0 rounded-md border border-(--map-edge) px-1.5 text-3xs font-medium text-content">{{ hiddenLit }}</span>
            </button>
        </template>
    </section>
</template>
