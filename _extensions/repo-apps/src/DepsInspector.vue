<script setup lang="ts">
import type { WorkspaceDepEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { Button, Icon, ui } from "@intentic/extension-ui";
import { computed } from "vue";
import { usageOf, type Area, type Closure } from "./depModel";
import { t } from "./i18n.js";

// One package, selected on the graph: where it sits, every sibling it declares and what its files do with each, what
// declares it, and how far a change to it reaches. The lists are its own direct edges, whatever the graph left out.

const props = defineProps<{
    pkg: WorkspacePackage;
    edges: readonly WorkspaceDepEdge[];
    closure: Closure | undefined;
    area: Area | undefined;
}>();
const emit = defineEmits<{ pick: [name: string]; close: []; lookInside: [name: string] }>();

const short = (name: string): string => name.split(`/`).at(-1) ?? name;
const uses = computed(() => props.edges.filter((edge) => edge.from === props.pkg.name).toSorted((a, b) => a.to.localeCompare(b.to)));
const usedBy = computed(() => props.edges.filter((edge) => edge.to === props.pkg.name).toSorted((a, b) => a.from.localeCompare(b.from)));
// A runtime dependency nothing uses, or only tests and tooling do, reads as the finding it is.
const tone = (edge: WorkspaceDepEdge): string =>
    edge.type !== `dev` && (usageOf(edge) === `none` || usageOf(edge) === `tooling`) ? `text-danger` : `text-subtle`;
</script>

<template>
    <aside class="flex min-h-0 flex-col gap-3 overflow-auto rounded-lg border border-line bg-card p-3">
        <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
                <h3 class="truncate text-sm font-semibold text-content" :title="pkg.name">{{ pkg.name }}</h3>
                <p class="truncate font-mono text-2xs text-subtle">{{ pkg.dir }}</p>
                <p v-if="area" class="mt-1 flex items-center gap-1.5 text-2xs text-muted">
                    <span class="h-2 w-2 rounded-full" :style="{ background: area.color }"></span>{{ area.label }}
                </p>
            </div>
            <button type="button" :class="ui.iconButton({ size: `sm` })" :aria-label="t(`dependenciesView.inspector.close`)" @click="emit(`close`)">
                <Icon name="times" />
            </button>
        </div>
        <dl v-if="closure" class="grid grid-cols-2 gap-2 text-2xs">
            <div>
                <dt class="flex items-center gap-1 text-muted">
                    <span class="h-2 w-2 rounded-full bg-warning"></span>{{ t(`dependenciesView.uses`) }}
                </dt>
                <dd class="text-lg font-semibold leading-tight text-content">{{ closure.uses.size }}</dd>
            </div>
            <div>
                <dt class="flex items-center gap-1 text-muted">
                    <span class="h-2 w-2 rounded-full bg-info"></span>{{ t(`dependenciesView.usedBy`) }}
                </dt>
                <dd class="text-lg font-semibold leading-tight text-content">{{ closure.usedBy.size }}</dd>
            </div>
        </dl>
        <p class="text-2xs text-subtle">{{ t(`dependenciesView.inspector.reach`) }}</p>
        <Button class="self-start" tier="boring" :label="t(`dependenciesView.inspector.lookInside`)" @click="emit(`lookInside`, pkg.name)" />

        <section class="flex flex-col gap-1">
            <h4 :class="ui.sectionLabel({ size: `xs` })">{{ t(`dependenciesView.inspector.declares`, { count: uses.length }) }}</h4>
            <button
                v-for="edge in uses"
                :key="`${edge.to}:${edge.type}`"
                type="button"
                class="flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-overlay"
                @click="emit(`pick`, edge.to)"
            >
                <span class="truncate text-content">{{ short(edge.to) }}</span>
                <span class="shrink-0 font-mono text-2xs" :class="tone(edge)"
                    >{{ t(`dependenciesView.usage.${usageOf(edge)}`) }} · {{ edge.type }}</span
                >
            </button>
        </section>
        <section class="flex flex-col gap-1">
            <h4 :class="ui.sectionLabel({ size: `xs` })">{{ t(`dependenciesView.inspector.declaredBy`, { count: usedBy.length }) }}</h4>
            <button
                v-for="edge in usedBy"
                :key="`${edge.from}:${edge.type}`"
                type="button"
                class="flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-overlay"
                @click="emit(`pick`, edge.from)"
            >
                <span class="truncate text-content">{{ short(edge.from) }}</span>
                <span class="shrink-0 font-mono text-2xs" :class="tone(edge)"
                    >{{ t(`dependenciesView.usage.${usageOf(edge)}`) }} · {{ edge.type }}</span
                >
            </button>
        </section>
    </aside>
</template>
