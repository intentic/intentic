<script setup lang="ts">
import { BrandMark, Icon, PersonaFace, toneDot, ui } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { nodeDetail, nodeLabel } from "./mapWords";
import type { MapNode, ReachHow } from "./reachModel";

// ONE THING ON THE MAP THE SANDBOX HOLDS OR REACHES, in the shape its place on the map wants: a `row` in an outward group,
// a `tile` for a part of the workspace inside the box, a `chip` for a persona or a secret. All three light the same way,
// so a reader learns one language: dim is out of reach, a ring in the focus's ink is in reach, a dashed ring is only
// through a persona, a pencil is edited by hand and an eye only read.

const t = useT();

const {
    node,
    variant,
    lit,
    pinned = false,
    areasExist = true,
} = defineProps<{
    node: MapNode;
    variant: `row` | `tile` | `chip`;
    lit: ReachHow | `self` | `related` | `off` | undefined;
    pinned?: boolean;
    areasExist?: boolean;
}>();
defineEmits<{ point: [on: boolean]; press: [] }>();

const label = computed(() => nodeLabel(node, areasExist));
const detail = computed(() => nodeDetail(node));
const reached = computed(() => lit !== undefined && lit !== `off`);
// The focus's ink only tints what it lights, mixed into the theme's own rule (SandboxMap sets the mixes): what is out of
// reach goes dim, so what is in reach needs no more than a hint to stand apart.
const edge = computed(() => {
    if (lit === `self`) {
        return `border-(--map-edge-strong) shadow-(--map-halo)`;
    }
    if (lit === `through`) {
        return `border-dashed border-(--map-edge)`;
    }
    return reached.value ? `border-(--map-edge)` : `border-line-subtle hover:border-line`;
});
// A row or a tile's own plate, washed with the ink when it is the focus; a chip keeps the kit's plate.
const plate = computed(() => (variant === `chip` ? (lit === `self` ? `bg-(--map-wash)` : ``) : lit === `self` ? `bg-(--map-wash)` : `bg-card`));
const mark = computed(() => (lit === `edit` ? `pencil` : lit === `see` ? `eye` : undefined));
const markTitle = computed(() => (lit === `edit` ? t(`sandbox.sandboxMap.legendEdits`) : t(`sandbox.sandboxMap.legendSees`)));
const persona = computed(() => ({ id: node.ref ?? node.id, label: node.label }));
const glyph = computed(() => (node.icon !== undefined && isIconName(node.icon) ? node.icon : `folder`));
// A row and a tile draw their own box; the chip is the kit's (its plate, radius, hover and touch target), opening on
// its face or glyph plate, and the map only lays its ring over it.
const body = computed(() =>
    variant === `row` ? `w-full gap-2 rounded-lg px-2 py-1` : variant === `tile` ? `w-full gap-2.5 rounded-xl px-3 py-2.5` : ui.chip({ lead: true }, `max-w-full`),
);
</script>

<template>
    <button
        type="button"
        :data-node="node.id"
        :aria-pressed="pinned"
        :title="detail === undefined ? label : `${label}\n${detail}`"
        class="relative flex min-w-0 items-center border text-left transition-[opacity,border-color,box-shadow,filter,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
        :class="[
            edge,
            plate,
            lit === `off` ? `opacity-30 saturate-0` : ``,
            body,
            node.kind === `rest` ? `border-dashed` : ``,
        ]"
        @pointerenter="$emit(`point`, true)"
        @pointerleave="$emit(`point`, false)"
        @focus="$emit(`point`, true)"
        @blur="$emit(`point`, false)"
        @click="$emit(`press`)"
    >
        <PersonaFace v-if="node.kind === `persona`" :persona="persona" :size="22" />
        <span v-else-if="node.kind === `model` && node.provider !== undefined" class="flex size-4.5 shrink-0 items-center justify-center text-content">
            <ProviderLogo :provider="node.provider" />
        </span>
        <span
            v-else-if="variant !== `row`"
            class="flex shrink-0 items-center justify-center text-muted"
            :class="variant === `tile` ? `size-7 rounded-lg bg-overlay text-sm` : `size-5 rounded-full bg-overlay text-2xs`"
        >
            <Icon :name="glyph" />
        </span>
        <BrandMark v-else :size="18" :name="label" :logo="node.logo" :icon="node.icon" />

        <span v-if="variant === `chip`" class="min-w-0 truncate text-xs" :class="node.kind === `secret` ? `font-mono text-muted` : `text-content`">{{ label }}</span>
        <span v-else class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-sm text-content" :class="variant === `tile` ? `font-medium` : ``">{{ label }}</span>
            <span v-if="detail !== undefined" class="truncate text-xs text-subtle" :class="variant === `tile` ? `font-mono text-2xs` : ``">{{ detail }}</span>
        </span>

        <!-- A tile's mark rides its corner, so it takes no width from the name; elsewhere it trails the row. -->
        <span
            v-if="mark !== undefined"
            class="text-xs text-(--map-mark)"
            :class="variant === `tile` ? `absolute right-1.5 top-1.5 text-2xs` : `shrink-0`"
            :title="markTitle"
            ><Icon :name="mark"
        /></span>
        <span v-if="node.live" class="relative flex size-2 shrink-0" :title="t(`sandbox.sandboxMap.live`)">
            <span class="map-live absolute inset-0 rounded-full bg-success opacity-60" />
            <span class="relative size-2 rounded-full bg-success" />
        </span>
        <span
            v-else-if="variant === `row` && node.state !== undefined && node.tone !== `success`"
            class="size-1.5 shrink-0 rounded-full"
            :class="toneDot(node.tone)"
            :title="node.state"
        />
    </button>
</template>

<style scoped>
/* A browser open on it now: the dot breathes. Under reduced motion it holds still, and the solid dot still says it. */
@keyframes map-live {
    75%,
    100% {
        transform: scale(2.2);
        opacity: 0;
    }
}
.map-live {
    animation: map-live 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
}
:root[data-motion="reduced"] .map-live {
    animation: none;
}
</style>
