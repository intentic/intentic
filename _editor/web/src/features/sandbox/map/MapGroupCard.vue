<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import MapNodeButton from "./MapNodeButton.vue";
import { GROUP_ICONS, groupLabel } from "./mapWords";
import type { Focus, Lighting, MapGroup, MapNode, ReachHow } from "./reachModel";

// ONE KIND OF THING THE SANDBOX REACHES (its services, its accounts, its machines…), as a card on the map's right edge.
// Each row is a line's end. A long group shows its first few and folds the rest behind one row, which still says how many
// of the folded ones the focus reaches, so a lit thing is never hidden without a trace.

const t = useT();

// Past this, the card folds: enough rows to read the group at a glance, few enough that six groups still fit a screen.
const FOLD_AT = 6;
const SHOWN_FOLDED = 4;

const { group, lighting, pinned, expanded } = defineProps<{
    group: MapGroup;
    lighting: Lighting | undefined;
    pinned: Focus | undefined;
    expanded: boolean;
}>();
defineEmits<{ point: [focus: Focus | undefined]; press: [focus: Focus]; toggle: [] }>();

const folds = computed(() => group.nodes.length > FOLD_AT);
const shown = computed(() => (folds.value && !expanded ? group.nodes.slice(0, SHOWN_FOLDED) : group.nodes));
const hidden = computed(() => group.nodes.length - shown.value.length);
const litOf = (id: string): ReachHow | `self` | `related` | `off` | undefined => (lighting === undefined ? undefined : (lighting.nodes.get(id) ?? `off`));
const litCount = computed(() => group.nodes.filter((node) => lighting?.nodes.has(node.id) === true).length);
const hiddenLit = computed(() => group.nodes.slice(shown.value.length).filter((node) => lighting?.nodes.has(node.id) === true).length);
const focusOf = (node: MapNode): Focus => ({ kind: `node`, id: node.id });
</script>

<template>
    <section :data-group="group.key" class="flex flex-col gap-0.5 rounded-xl border border-line-subtle bg-canvas p-1.5">
        <header class="flex items-center gap-2 px-1.5 pb-1 pt-0.5 text-xs text-muted">
            <Icon :name="GROUP_ICONS[group.key]" class="shrink-0" />
            <h3 class="min-w-0 flex-1 truncate font-medium">{{ groupLabel(group.key) }}</h3>
            <span class="shrink-0 tabular-nums" :class="lighting === undefined ? `text-subtle` : litCount > 0 ? `text-(--map-ink)` : `text-faint`">
                {{ lighting === undefined ? group.nodes.length : t(`sandbox.sandboxMap.litOf`, { lit: litCount, total: group.nodes.length }) }}
            </span>
        </header>
        <MapNodeButton
            v-for="node in shown"
            :key="node.id"
            :node
            variant="row"
            :lit="litOf(node.id)"
            :pinned="pinned?.id === node.id"
            @point="(on) => $emit(`point`, on ? focusOf(node) : undefined)"
            @press="$emit(`press`, focusOf(node))"
        />
        <button
            v-if="folds"
            type="button"
            :data-node="`more:${group.key}`"
            class="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1 text-left text-xs text-muted transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
            :aria-expanded="expanded"
            @click="$emit(`toggle`)"
        >
            <Icon :name="expanded ? `chevron-up` : `chevron-down`" />
            <span class="min-w-0 flex-1 truncate">{{ expanded ? t(`sandbox.sandboxMap.fewer`) : t(`sandbox.sandboxMap.more`, { count: hidden }, hidden) }}</span>
            <span v-if="!expanded && hiddenLit > 0" class="shrink-0 rounded-md px-1.5 text-3xs font-medium text-(--map-ink) ring-1 ring-(--map-ink)">{{
                hiddenLit
            }}</span>
        </button>
    </section>
</template>
