<script setup lang="ts">
import { Await, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { settingKey, storedValue, storeValue } from "@intentic/ui/storage";
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { identityHue } from "../../../lib/identityHue";
import type { ModelSource } from "../models/modelSources";
import MapCaption from "./MapCaption.vue";
import MapStage from "./MapStage.vue";
import { type Focus, lightingOf } from "./reachLighting";
import { useReachMap } from "./useReachMap";

// SANDBOX ▸ MAP: the sandbox's whole access and reach on one drawing. Who can get in (people, control tokens, other
// sandboxes' links), the box itself (its areas, roles and secrets), and everything it reaches once they are in
// (connections, accounts and browsers, machines, other sandboxes, what it publishes, the models it runs on). Pointing at
// a way in lights what it reaches and dims the rest; pointing at a thing lights who reaches it. A press keeps a focus
// lit while the pointer moves on, and Escape or the caption's close lets it go.
//
// Read only: every line is drawn from what the daemon enforces (reachModel.ts), and every change is made on the page
// that owns it, which the caption links to.

const t = useT();
const { models } = defineProps<{
    /** What the sandbox runs models on, as the hub already reads it for its Models row. */
    models: readonly ModelSource[];
}>();
const { map, input, drawnFrom } = useReachMap(() => models);
const { active } = useSandbox();

const hovered = shallowRef<Focus>();
const pinned = shallowRef<Focus>();
const focus = computed(() => hovered.value ?? pinned.value);
const lighting = computed(() => (focus.value === undefined ? undefined : lightingOf(map.value, input.value, focus.value)));

// Leaving one card for the next crosses a gap: the old focus holds a beat, so the map doesn't flash dark in between.
const LEAVE_GRACE_MS = 90;
let leaving: ReturnType<typeof setTimeout> | undefined;
const point = (next: Focus | undefined): void => {
    clearTimeout(leaving);
    if (next !== undefined) {
        hovered.value = next;
        return;
    }
    leaving = setTimeout(() => (hovered.value = undefined), LEAVE_GRACE_MS);
};
const press = (next: Focus): void => {
    pinned.value = pinned.value?.id === next.id ? undefined : next;
};
const clear = (): void => {
    pinned.value = undefined;
    hovered.value = undefined;
};

// A pinned thing that left the map (a token revoked, a connection removed) stops holding the focus.
watch(map, (now) => {
    const held = pinned.value;
    if (held !== undefined && !(held.kind === `principal` ? now.principals.some((entry) => entry.id === held.id) : now.nodes.has(held.id))) {
        pinned.value = undefined;
    }
});

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && pinned.value !== undefined) {
        clear();
    }
};
onMounted(() => window.addEventListener(`keydown`, onKey));
onBeforeUnmount(() => {
    window.removeEventListener(`keydown`, onKey);
    clearTimeout(leaving);
});

// A person's own colour carries their focus, so their lines read as theirs; anything else wears the link ink. Mixed toward
// the text so it holds its contrast on a light canvas and a dark one.
const ink = computed(() => {
    const principal = focus.value?.kind === `principal` ? map.value.principals.find((entry) => entry.id === focus.value?.id) : undefined;
    return principal?.kind === `person`
        ? `color-mix(in oklab, hsl(${identityHue(principal.label)} 70% 52%) 78%, var(--color-content))`
        : `var(--color-link)`;
});

// The focus's ink, mixed into the theme so it tints rather than shouts: a lit card's edge is the theme's rule leaning toward
// the ink, the focus's own a little further with a soft halo and wash, and a lit line the ink eased toward the card.
const look = computed(() => ({
    "--map-ink": ink.value,
    "--map-line": `color-mix(in oklab, var(--color-line-strong) 70%, var(--color-content))`,
    "--map-stroke": `color-mix(in oklab, var(--map-ink) 82%, var(--color-card))`,
    "--map-edge": `color-mix(in oklab, var(--map-ink) 38%, var(--color-line))`,
    "--map-edge-strong": `color-mix(in oklab, var(--map-ink) 60%, var(--color-line))`,
    "--map-mark": `color-mix(in oklab, var(--map-ink) 75%, var(--color-muted))`,
    "--map-wash": `color-mix(in oklab, var(--map-ink) 6%, var(--color-card))`,
    "--map-halo": `0 0 0 3px color-mix(in oklab, var(--map-ink) 12%, transparent)`,
}));

const roleName = (id: string): string => map.value.roles.find((card) => card.ref === id)?.label ?? id;

// Compact first: the drawing reads at a glance, and every block opens where its detail is wanted. The reader's choice is
// the account's setting (@intentic/ui/storage), a view preference rather than anything about the sandbox.
type MapView = `compact` | `detailed`;
const VIEW_KEY = settingKey(`intentic.sandboxMap.view`);
const view = shallowRef<MapView>(storedValue(VIEW_KEY) === `detailed` ? `detailed` : `compact`);
const setView = (next: MapView): void => {
    view.value = next;
    storeValue(VIEW_KEY, next);
};
const views = computed(() => [
    { label: t(`sandbox.sandboxMap.viewCompact`), value: `compact` as const },
    { label: t(`sandbox.sandboxMap.viewDetailed`), value: `detailed` as const },
]);
</script>

<template>
    <div class="flex flex-col gap-3" :style="look">
        <!-- One line, kept in view while the drawing scrolls: what the focus means, and how much the drawing shows. Drawn
             ahead of the reads: with nothing in focus it is the same hint and switch whatever the sandbox holds. -->
        <div class="sticky top-0 z-10 -mx-1 flex min-w-0 items-center gap-3 bg-canvas px-1 py-1">
            <MapCaption :map :focus :lighting :pinned="pinned !== undefined" :role-name @clear="clear" />
            <SegmentedControl
                class="shrink-0"
                size="xs"
                :model-value="view"
                :options="views"
                :aria-label="t(`sandbox.sandboxMap.viewLabel`)"
                @update:model-value="setView"
            />
        </div>
        <Await :of="drawnFrom" imprint="sandbox.map">
            <!-- Until it has been seen once: the compact drawing's three columns with their fixed headings, a few ways in, the
                 box and its outward blocks. The stage lays its columns out by its own measured width; here the same
                 breakpoints are container widths, so nothing is measured for a placeholder. -->
            <template #fallback>
                <div role="status" aria-busy="true" :aria-label="t(`ui.status.loading`)" class="@container">
                    <div
                        class="grid grid-cols-1 gap-y-10 @[600px]:grid-cols-[minmax(8.5rem,12rem)_minmax(13rem,1fr)_minmax(10rem,14rem)] @[600px]:items-start @[600px]:gap-x-12 @[600px]:gap-y-3 @[900px]:grid-cols-[minmax(10rem,13.5rem)_minmax(15rem,1fr)_minmax(12rem,16.5rem)] @[900px]:gap-x-16"
                        aria-hidden="true"
                    >
                        <h2 class="hidden px-1 text-xs font-medium text-muted @[600px]:block">{{ t(`sandbox.sandboxMap.whoGetsIn`) }}</h2>
                        <span class="hidden @[600px]:block" />
                        <h2 class="hidden px-1 text-xs font-medium text-muted @[600px]:block">{{ t(`sandbox.sandboxMap.whatItReaches`) }}</h2>

                        <section class="flex min-w-0 flex-col gap-4">
                            <div v-for="(rows, cluster) in [3, 2]" :key="cluster" class="flex flex-col gap-1.5">
                                <span class="flex h-[1lh] items-center px-1 text-2xs"><span class="skeleton block h-2 w-14" /></span>
                                <div class="grid grid-cols-1 gap-1">
                                    <span v-for="row in rows" :key="row" class="flex items-center gap-2 rounded-lg border border-line-subtle bg-card px-2 py-1">
                                        <span class="skeleton block size-5 shrink-0 rounded-full" />
                                        <span class="flex h-[1lh] min-w-0 flex-1 items-center text-sm"><span class="skeleton block h-3 w-3/5" /></span>
                                    </span>
                                </div>
                            </div>
                        </section>

                        <div class="flex flex-col gap-3 rounded-2xl border border-line bg-card p-3">
                            <span class="flex items-center gap-2.5">
                                <span class="skeleton block size-6.5 shrink-0 rounded-lg" />
                                <span class="flex h-[1lh] items-center text-sm"><span class="skeleton block h-3 w-24" /></span>
                            </span>
                            <section v-for="(chips, index) in [[`w-20`, `w-16`, `w-24`], [`w-24`, `w-16`, `w-20`]]" :key="index" class="flex flex-col gap-1.5">
                                <h3 class="text-2xs font-medium text-muted">{{ index === 0 ? t(`sandbox.sandboxMap.workspace`) : t(`sandbox.sandboxMap.roles`) }}</h3>
                                <div class="flex flex-wrap gap-1.5">
                                    <span v-for="width in chips" :key="width" :class="ui.chip({ lead: true })">
                                        <span class="skeleton block size-4 shrink-0 rounded-full" />
                                        <span class="skeleton block h-2.5" :class="width" />
                                    </span>
                                </div>
                            </section>
                        </div>

                        <section class="grid grid-cols-1 items-start gap-2">
                            <span v-for="row in 6" :key="row" class="flex items-center gap-2.5 rounded-xl border border-line-subtle bg-card px-2.5 pb-2.5 pt-2">
                                <span class="skeleton block size-7 shrink-0 rounded-lg" />
                                <span class="flex min-w-0 flex-1 flex-col gap-1">
                                    <span class="flex h-[1lh] items-center text-sm"><span class="skeleton block h-3 w-20" /></span>
                                    <span class="flex gap-1.5"><span v-for="mark in 4" :key="mark" class="skeleton block size-3 rounded-sm" /></span>
                                </span>
                            </span>
                        </section>
                    </div>
                </div>
            </template>
            <MapStage
                :map
                :lighting
                :focus
                :pinned
                :name="active?.name ?? t(`sandbox.sandboxMap.theSandbox`)"
                :role-name
                :compact="view === `compact`"
                @point="point"
                @press="press"
                @clear="clear"
            />
        </Await>
    </div>
</template>
