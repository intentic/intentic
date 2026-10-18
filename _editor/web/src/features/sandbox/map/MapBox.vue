<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import MapNodeButton from "./MapNodeButton.vue";
import { bundleId, type Focus, type Lighting } from "./reachLighting";
import type { MapNode, ReachHow, ReachMap } from "./reachModel";

// THE SANDBOX ITSELF, drawn as the box the map is about: the ground its workspace is split into (areas, and whatever no
// area names), the personas that live on that ground, and the secrets it keeps. Everything that gets in arrives at its
// left edge and everything it reaches leaves from its right, so what lights up inside it is where a principal lands.
//
// Compact, the ground and the personas stay (they are what a person's access is made of), as chips rather than tiles,
// and the secrets fold into one chip that counts them, and how many the focus reaches; a press opens it.

const t = useT();

const {
    map,
    lighting,
    pinned,
    name,
    compact = false,
} = defineProps<{
    map: ReachMap;
    lighting: Lighting | undefined;
    pinned: Focus | undefined;
    name: string;
    compact?: boolean;
}>();
const emit = defineEmits<{ point: [focus: Focus | undefined]; press: [focus: Focus] }>();

const litOf = (id: string): ReachHow | `self` | `related` | `off` | undefined => (lighting === undefined ? undefined : (lighting.nodes.get(id) ?? `off`));
const focusOf = (node: MapNode): Focus => ({ kind: `node`, id: node.id });
const areasExist = (): boolean => map.areas.length > 1;

const SECRETS = bundleId(`secrets`);
const secretsOpen = ref(false);
watch(
    () => compact,
    () => (secretsOpen.value = false),
);
const secretsFolded = computed(() => compact && !secretsOpen.value);
const secretsLit = computed(() => map.secrets.filter((node) => lighting?.nodes.has(node.id) === true).length);
const secretsCount = computed(() =>
    lighting === undefined ? String(map.secrets.length) : t(`sandbox.sandboxMap.litOf`, { lit: secretsLit.value, total: map.secrets.length }),
);
// The folded chip lights as one card, as a folded group does (MapGroupCard).
const secretsEdge = computed(() => {
    if (lighting === undefined) {
        return `border-line-subtle hover:border-line`;
    }
    if (lighting.nodes.get(SECRETS) === `self`) {
        return `border-(--map-edge-strong) bg-(--map-wash) shadow-(--map-halo)`;
    }
    return secretsLit.value > 0 ? `border-(--map-edge)` : `border-line-subtle opacity-30`;
});
</script>

<template>
    <div data-map-box class="@container relative flex flex-col rounded-2xl border border-line bg-card" :class="compact ? `gap-3 p-3` : `gap-4 p-4`">
        <header class="flex min-w-0 items-center gap-2.5">
            <span
                class="flex shrink-0 items-center justify-center rounded-lg bg-primary-tint text-accent"
                :class="compact ? `size-6.5 text-sm` : `size-8 text-base`"
                ><Icon name="box"
            /></span>
            <span class="flex min-w-0 flex-col">
                <span class="truncate font-semibold text-content" :class="compact ? `text-sm` : `text-base`">{{ name }}</span>
                <span v-if="!compact" class="text-xs text-subtle">{{ t(`sandbox.sandboxMap.theSandbox`) }}</span>
            </span>
        </header>

        <section class="flex flex-col gap-1.5">
            <h3 class="text-2xs font-medium text-muted">{{ t(`sandbox.sandboxMap.workspace`) }}</h3>
            <div :class="compact ? `flex flex-wrap gap-1.5` : `grid grid-cols-1 gap-1.5 @[20rem]:grid-cols-2`">
                <MapNodeButton
                    v-for="node in map.areas"
                    :key="node.id"
                    :node
                    :variant="compact ? `chip` : `tile`"
                    :lit="litOf(node.id)"
                    :pinned="pinned?.id === node.id"
                    :areas-exist="areasExist()"
                    :class="!compact && node.kind === `rest` ? `@[20rem]:col-span-2` : ``"
                    @point="(on) => emit(`point`, on ? focusOf(node) : undefined)"
                    @press="emit(`press`, focusOf(node))"
                />
            </div>
        </section>

        <section v-if="map.personas.length > 0" class="flex flex-col gap-1.5">
            <h3 class="text-2xs font-medium text-muted">{{ t(`sandbox.sandboxMap.personas`) }}</h3>
            <div class="flex flex-wrap gap-1.5">
                <MapNodeButton
                    v-for="node in map.personas"
                    :key="node.id"
                    :node
                    variant="chip"
                    :lit="litOf(node.id)"
                    :pinned="pinned?.id === node.id"
                    @point="(on) => emit(`point`, on ? focusOf(node) : undefined)"
                    @press="emit(`press`, focusOf(node))"
                />
            </div>
        </section>

        <section v-if="map.secrets.length > 0" class="flex flex-col gap-1.5">
            <h3 v-if="!secretsFolded" class="text-2xs font-medium text-muted">{{ t(`sandbox.sandboxMap.secrets`) }}</h3>
            <div class="flex flex-wrap gap-1.5">
                <button
                    v-if="secretsFolded"
                    type="button"
                    :data-node="SECRETS"
                    :aria-expanded="false"
                    :title="t(`sandbox.sandboxMap.openGroup`)"
                    class="ui-chip border transition-[opacity,border-color,box-shadow,background-color]"
                    :class="secretsEdge"
                    @pointerenter="emit(`point`, { kind: `node`, id: SECRETS })"
                    @pointerleave="emit(`point`, undefined)"
                    @focus="emit(`point`, { kind: `node`, id: SECRETS })"
                    @blur="emit(`point`, undefined)"
                    @click="secretsOpen = true"
                >
                    <Icon name="key" />
                    <span>{{ t(`sandbox.sandboxMap.secrets`) }}</span>
                    <span class="tabular-nums" :class="lighting !== undefined && secretsLit > 0 ? `font-medium text-content` : `text-subtle`">{{
                        secretsCount
                    }}</span>
                </button>
                <template v-else>
                    <MapNodeButton
                        v-for="node in map.secrets"
                        :key="node.id"
                        :node
                        variant="chip"
                        :lit="litOf(node.id)"
                        :pinned="pinned?.id === node.id"
                        @point="(on) => emit(`point`, on ? focusOf(node) : undefined)"
                        @press="emit(`press`, focusOf(node))"
                    />
                    <button
                        v-if="compact"
                        type="button"
                        class="ui-chip"
                        :aria-expanded="true"
                        :title="t(`sandbox.sandboxMap.foldGroup`)"
                        :aria-label="t(`sandbox.sandboxMap.foldGroup`)"
                        @click="secretsOpen = false"
                    >
                        <Icon name="chevron-up" />
                    </button>
                </template>
            </div>
        </section>
    </div>
</template>
