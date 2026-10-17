<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import MapNodeButton from "./MapNodeButton.vue";
import type { Focus, Lighting, MapNode, ReachHow, ReachMap } from "./reachModel";

// THE SANDBOX ITSELF, drawn as the box the map is about: the ground its workspace is split into (areas, and whatever no
// area names), the personas that live on that ground, and the secrets it keeps. Everything that gets in arrives at its
// left edge and everything it reaches leaves from its right, so what lights up inside it is where a principal lands.

const t = useT();

const { map, lighting, pinned, name } = defineProps<{
    map: ReachMap;
    lighting: Lighting | undefined;
    pinned: Focus | undefined;
    name: string;
}>();
defineEmits<{ point: [focus: Focus | undefined]; press: [focus: Focus] }>();

const litOf = (id: string): ReachHow | `self` | `related` | `off` | undefined => (lighting === undefined ? undefined : (lighting.nodes.get(id) ?? `off`));
const focusOf = (node: MapNode): Focus => ({ kind: `node`, id: node.id });
const areasExist = (): boolean => map.areas.length > 1;
</script>

<template>
    <div data-map-box class="@container relative flex flex-col gap-4 rounded-2xl border border-line-strong bg-card p-4 shadow-sm">
        <header class="flex min-w-0 items-center gap-2.5">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-base text-accent"><Icon name="box" /></span>
            <span class="flex min-w-0 flex-col">
                <span class="truncate text-base font-semibold text-content">{{ name }}</span>
                <span class="text-xs text-subtle">{{ t(`sandbox.sandboxMap.theSandbox`) }}</span>
            </span>
        </header>

        <section class="flex flex-col gap-2">
            <h3 class="text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.workspace`) }}</h3>
            <div class="grid grid-cols-1 gap-1.5 @[20rem]:grid-cols-2">
                <MapNodeButton
                    v-for="node in map.areas"
                    :key="node.id"
                    :node
                    variant="tile"
                    :lit="litOf(node.id)"
                    :pinned="pinned?.id === node.id"
                    :areas-exist="areasExist()"
                    :class="node.kind === `rest` ? `@[20rem]:col-span-2` : ``"
                    @point="(on) => $emit(`point`, on ? focusOf(node) : undefined)"
                    @press="$emit(`press`, focusOf(node))"
                />
            </div>
        </section>

        <section v-if="map.personas.length > 0" class="flex flex-col gap-2">
            <h3 class="text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.personas`) }}</h3>
            <div class="flex flex-wrap gap-1.5">
                <MapNodeButton
                    v-for="node in map.personas"
                    :key="node.id"
                    :node
                    variant="chip"
                    :lit="litOf(node.id)"
                    :pinned="pinned?.id === node.id"
                    @point="(on) => $emit(`point`, on ? focusOf(node) : undefined)"
                    @press="$emit(`press`, focusOf(node))"
                />
            </div>
        </section>

        <section v-if="map.secrets.length > 0" class="flex flex-col gap-2">
            <h3 class="text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.secrets`) }}</h3>
            <div class="flex flex-wrap gap-1.5">
                <MapNodeButton
                    v-for="node in map.secrets"
                    :key="node.id"
                    :node
                    variant="chip"
                    :lit="litOf(node.id)"
                    :pinned="pinned?.id === node.id"
                    @point="(on) => $emit(`point`, on ? focusOf(node) : undefined)"
                    @press="$emit(`press`, focusOf(node))"
                />
            </div>
        </section>
    </div>
</template>
