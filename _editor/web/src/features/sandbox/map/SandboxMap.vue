<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { identityHue } from "../../../lib/identityHue";
import type { ModelSource } from "../models/modelSources";
import MapCaption from "./MapCaption.vue";
import MapStage from "./MapStage.vue";
import { type Focus, lightingOf } from "./reachModel";
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
const { map, input } = useReachMap(() => models);
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

const personaName = (id: string): string => map.value.personas.find((card) => card.ref === id)?.label ?? id;
</script>

<template>
    <div class="flex flex-col gap-4">
        <p class="max-w-prose text-sm text-muted">{{ t(`sandbox.sandboxMap.lede`) }}</p>
        <div class="sticky top-0 z-10 -mx-1 bg-canvas px-1 pb-2 pt-1" :style="{ '--map-ink': ink }">
            <MapCaption :map :focus :pinned="pinned !== undefined" :persona-name @clear="clear" />
        </div>
        <MapStage
            :map
            :lighting
            :focus
            :pinned
            :name="active?.name ?? t(`sandbox.sandboxMap.theSandbox`)"
            :ink
            :persona-name
            @point="point"
            @press="press"
            @clear="clear"
        />
    </div>
</template>
