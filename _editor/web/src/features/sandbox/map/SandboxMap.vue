<script setup lang="ts">
import { Await, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { deviceKey, storedValue, storeValue } from "@intentic/ui/storage";
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { identityHue } from "../../../lib/identityHue";
import type { ModelSource } from "../models/modelSources";
import MapCaption from "./MapCaption.vue";
import MapStage from "./MapStage.vue";
import { type Focus, lightingOf } from "./reachLighting";
import { useReachMap } from "./useReachMap";

// SANDBOX ▸ MAP: the sandbox's whole access and reach on one drawing. Who can get in (people, control tokens, other
// sandboxes' links), the box itself (its areas, personas and secrets), and everything it reaches once they are in
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

const personaName = (id: string): string => map.value.personas.find((card) => card.ref === id)?.label ?? id;

// Compact first: the drawing reads at a glance, and every block opens where its detail is wanted. The reader's choice is
// kept on this device, as a view preference rather than anything about the sandbox.
type MapView = `compact` | `detailed`;
const VIEW_KEY = deviceKey(`intentic.sandboxMap.view`);
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
    <Await :of="drawnFrom">
        <div class="flex flex-col gap-3" :style="look">
            <!-- One line, kept in view while the drawing scrolls: what the focus means, and how much the drawing shows. -->
            <div class="sticky top-0 z-10 -mx-1 flex min-w-0 items-center gap-3 bg-canvas px-1 py-1">
                <MapCaption :map :focus :lighting :pinned="pinned !== undefined" :persona-name @clear="clear" />
                <SegmentedControl
                    class="shrink-0"
                    size="xs"
                    :model-value="view"
                    :options="views"
                    :aria-label="t(`sandbox.sandboxMap.viewLabel`)"
                    @update:model-value="setView"
                />
            </div>
            <MapStage
                :map
                :lighting
                :focus
                :pinned
                :name="active?.name ?? t(`sandbox.sandboxMap.theSandbox`)"
                :persona-name
                :compact="view === `compact`"
                @point="point"
                @press="press"
                @clear="clear"
            />
        </div>
    </Await>
</template>
