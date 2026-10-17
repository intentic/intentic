<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { lessMotion } from "@intentic/ui/motion";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import MapBox from "./MapBox.vue";
import MapGroupCard from "./MapGroupCard.vue";
import MapPrincipalRow from "./MapPrincipalRow.vue";
import { drawMap } from "./mapEdges";
import type { Flow } from "./mapGeometry";
import type { PersonaName } from "./mapWords";
import type { Focus, GroupKey, Lighting, Principal, PrincipalKind, ReachMap } from "./reachModel";
import { useMapLayout } from "./useMapLayout";

// THE MAP'S STAGE: who gets in on the left, the box in the middle, what it reaches on the right, and the lines between
// them. The cards are laid out by CSS, so the map reads at any width; the lines are drawn after, from where the cards
// landed (useMapLayout, mapEdges.ts). Wide enough, the three stand side by side and the lines run across; narrower, they
// stack and the lines run down. The stage only draws: what is in focus is its parent's, told back through `point`
// (the pointer or the keyboard arriving, undefined as it leaves) and `press` (keep it lit).

const t = useT();

const {
    map,
    lighting,
    focus,
    pinned,
    name,
    personaName,
    compact = false,
} = defineProps<{
    map: ReachMap;
    lighting: Lighting | undefined;
    focus: Focus | undefined;
    pinned: Focus | undefined;
    name: string;
    personaName: PersonaName;
    /** One line per way in, one block per group, the secrets folded: the drawing without its fine print. */
    compact?: boolean;
}>();
const emit = defineEmits<{ point: [focus: Focus | undefined]; press: [focus: Focus]; clear: [] }>();

// Side by side from here; below it the three columns would squeeze names to nothing. Roomy from the second: wider gutters
// for the lines to bend in. Wide from the third, where the columns stop growing and the drawing centres in the page.
const ACROSS_FROM = 600;
const ROOMY_FROM = 900;
const WIDE_FROM = 1240;
// Two columns of rows within a stacked section from here.
const PAIRS_FROM = 520;

const stage = ref<HTMLElement>();
const expanded = shallowRef<ReadonlySet<GroupKey>>(new Set());
const { layout } = useMapLayout(stage, () => [map, expanded.value, compact]);
// What was opened in one view means something else in the other: a detailed card's unfolded tail, a compact block opened.
watch(
    () => compact,
    () => (expanded.value = new Set()),
);

const ready = computed(() => layout.value.width > 0);
const flow = computed<Flow>(() => (layout.value.width >= ACROSS_FROM ? `across` : `down`));
const pairs = computed(() => flow.value === `down` && layout.value.width >= PAIRS_FROM);
const columns = computed(() => {
    if (flow.value === `down`) {
        return `grid-cols-1 gap-y-10`;
    }
    if (layout.value.width >= WIDE_FROM) {
        return `grid-cols-[minmax(11rem,15rem)_minmax(18rem,32rem)_minmax(14rem,20rem)] justify-center items-start gap-x-24 gap-y-3`;
    }
    return layout.value.width >= ROOMY_FROM
        ? `grid-cols-[minmax(10rem,13.5rem)_minmax(15rem,1fr)_minmax(12rem,16.5rem)] items-start gap-x-16 gap-y-3`
        : `grid-cols-[minmax(8.5rem,12rem)_minmax(13rem,1fr)_minmax(10rem,14rem)] items-start gap-x-12 gap-y-3`;
});
const drawing = computed(() => drawMap(layout.value, map, lighting, flow.value, focus?.kind === `node` ? focus.id : undefined));
const lines = computed(() => drawing.value.edges.filter((edge) => edge.kind !== `thread`));
const threads = computed(() => drawing.value.edges.filter((edge) => edge.kind === `thread`));

// The one entrance: the lines grow out of the box the first time the map is drawn, and never again.
const growing = ref(false);
let grown: ReturnType<typeof setTimeout> | undefined;
watch(
    () => lines.value.length > 0,
    (drawn) => {
        if (!drawn || grown !== undefined || lessMotion()) {
            return;
        }
        growing.value = true;
        grown = setTimeout(() => (growing.value = false), 1400);
    },
);
onBeforeUnmount(() => clearTimeout(grown));

const CLUSTERS: readonly { readonly kind: PrincipalKind; readonly label: () => string }[] = [
    { kind: `person`, label: () => t(`sandbox.sandboxMap.people`) },
    { kind: `token`, label: () => t(`sandbox.sandboxMap.tokens`) },
    { kind: `link`, label: () => t(`sandbox.sandboxMap.linked`) },
];
const clusters = computed(() =>
    CLUSTERS.map((cluster) => ({ ...cluster, principals: map.principals.filter((principal) => principal.kind === cluster.kind) })).filter(
        (cluster) => cluster.principals.length > 0,
    ),
);

const principalLit = (principal: Principal) => (lighting === undefined ? undefined : (lighting.principals.get(principal.id) ?? `off`));
const toggle = (key: GroupKey): void => {
    const next = new Set(expanded.value);
    if (!next.delete(key)) {
        next.add(key);
    }
    expanded.value = next;
};
const principalFocus = (principal: Principal): Focus => ({ kind: `principal`, id: principal.id });

// The lit line wears the focus's stroke, the resting one the theme's rule; both are mixed in SandboxMap.
const stroke = (state: `rest` | `on` | `off`): string => (state === `on` ? `var(--map-stroke)` : `var(--map-line)`);
</script>

<template>
    <div
        ref="stage"
        class="relative transition-opacity"
        :class="ready ? `opacity-100` : `opacity-0`"
        @click.self="emit(`clear`)"
    >
        <!-- Under the cards: a line runs behind every card it passes, never over a name. -->
        <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" :width="layout.width" :height="layout.height" aria-hidden="true">
            <g :class="growing ? `map-grow` : ``">
                <path
                    v-for="(edge, index) in lines"
                    :key="edge.key"
                    :d="edge.d"
                    fill="none"
                    stroke-linecap="round"
                    :path-length="growing ? 1 : undefined"
                    :stroke="stroke(edge.state)"
                    :stroke-width="edge.state === `on` ? 1.5 : 1.15"
                    :stroke-dasharray="edge.dashed ? `5 4` : edge.faint ? `1 4` : undefined"
                    :opacity="edge.state === `off` ? 0.14 : edge.faint ? 0.55 : 1"
                    :style="{ '--map-i': index }"
                    class="transition-[stroke,opacity,stroke-width]"
                />
            </g>
        </svg>

        <div
            class="relative grid"
            :class="columns"
            @click.self="emit(`clear`)"
        >
            <template v-if="flow === `across`">
                <h2 class="px-1 text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.whoGetsIn`) }}</h2>
                <span />
                <h2 class="px-1 text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.whatItReaches`) }}</h2>
            </template>

            <section class="flex min-w-0 flex-col gap-4" :aria-label="t(`sandbox.sandboxMap.whoGetsIn`)">
                <h2 v-if="flow === `down`" class="px-1 text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.whoGetsIn`) }}</h2>
                <div v-for="cluster in clusters" :key="cluster.kind" class="flex flex-col gap-1.5">
                    <h3 class="px-1 text-2xs text-subtle">{{ cluster.label() }}</h3>
                    <div class="grid" :class="[pairs ? `grid-cols-2` : `grid-cols-1`, compact ? `gap-1` : `gap-1.5`]">
                        <MapPrincipalRow
                            v-for="principal in cluster.principals"
                            :key="principal.id"
                            :principal
                            :lit="principalLit(principal)"
                            :pinned="pinned?.id === principal.id"
                            :persona-name
                            :compact
                            @point="(on) => emit(`point`, on ? principalFocus(principal) : undefined)"
                            @press="emit(`press`, principalFocus(principal))"
                        />
                    </div>
                </div>
                <p v-if="!map.rosterRead" class="flex items-start gap-1.5 px-1 text-xs text-subtle">
                    <Icon name="lock" class="mt-0.5 shrink-0" />
                    <span>{{ t(`sandbox.sandboxMap.rosterHidden`) }}</span>
                </p>
            </section>

            <MapBox :map :lighting :pinned :name :compact @point="(next) => emit(`point`, next)" @press="(next) => emit(`press`, next)" />

            <section class="flex min-w-0 flex-col gap-3" :aria-label="t(`sandbox.sandboxMap.whatItReaches`)">
                <h2 v-if="flow === `down`" class="px-1 text-xs font-medium text-muted">{{ t(`sandbox.sandboxMap.whatItReaches`) }}</h2>
                <div class="grid items-start" :class="[pairs ? `grid-cols-2` : `grid-cols-1`, compact ? `gap-2` : `gap-3`]">
                    <MapGroupCard
                        v-for="group in map.groups"
                        :key="group.key"
                        :group
                        :lighting
                        :pinned
                        :expanded="expanded.has(group.key)"
                        :compact
                        @point="(next) => emit(`point`, next)"
                        @press="(next) => emit(`press`, next)"
                        @toggle="toggle(group.key)"
                    />
                </div>
                <div v-if="map.groups.length === 0" class="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong p-4">
                    <span class="text-sm text-muted">{{ t(`sandbox.sandboxMap.nothingConnected`) }}</span>
                    <RouterLink to="/capabilities" class="text-sm font-medium text-link hover:underline">{{ t(`sandbox.sandboxMap.connect`) }}</RouterLink>
                </div>
            </section>
        </div>

        <!-- Over the cards: the box's doors and ports sit on its border, and a focus's threads cross it. -->
        <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" :width="layout.width" :height="layout.height" aria-hidden="true">
            <path
                v-for="edge in threads"
                :key="edge.key"
                :d="edge.d"
                fill="none"
                stroke="var(--map-stroke)"
                stroke-width="1.5"
                stroke-dasharray="2 3"
                stroke-linecap="round"
                class="map-thread"
            />
            <circle
                v-for="socket in [...drawing.doors, ...drawing.ports]"
                :key="socket.key"
                :cx="socket.at.x"
                :cy="socket.at.y"
                r="4"
                stroke-width="1.5"
                :fill="socket.state === `on` ? `var(--map-stroke)` : `var(--color-card)`"
                :stroke="socket.state === `on` ? `var(--map-stroke)` : `var(--map-line)`"
                :opacity="socket.state === `off` ? 0.5 : 1"
                class="transition-[fill,stroke,opacity]"
            />
        </svg>
    </div>
</template>

<style scoped>
/* THE ONE ENTRANCE: every line grows from its start, a step after the one before, on the house curve. Reduced motion never
   sets `map-grow` (lessMotion), and zeroes the clock besides. */
@keyframes map-grow {
    from {
        stroke-dashoffset: 1;
    }
    to {
        stroke-dashoffset: 0;
    }
}
.map-grow path {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: map-grow var(--motion-grow) var(--ease-smooth) forwards;
    animation-delay: calc(var(--map-i) * var(--motion-grow-step));
}

/* A thread is drawn the moment its focus lands, and fades in rather than popping. */
@keyframes map-thread {
    from {
        opacity: 0;
    }
}
.map-thread {
    animation: map-thread var(--motion-base) var(--ease-smooth);
}
</style>
