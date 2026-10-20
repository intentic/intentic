<!-- The one place a read's `Loaded` becomes pixels: what a region looked like last time while its answer is on its way, the answer once it is here, and the failure in words when it gave up. -->
<script setup lang="ts" generic="T">
import { AWAIT_SCOPE, joinAwait, type Loaded } from "@intentic/extension-api";
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowReactive, type VNode, watch } from "vue";
import { useNow } from "../../composables/useNow.js";
import { useLoadingReveal } from "../../composables/loadingReveal.js";
import { useT } from "../../i18n/index.js";
import { formatElapsed } from "../../lib/format.js";
import { vSkeletonSource } from "../../lib/skeleton/skeletonSource.js";
import Notice from "./Notice.vue";
import SkeletonRows from "./SkeletonRows.vue";
import SkeletonSnapshot from "./SkeletonSnapshot.vue";

// A REGION'S WAIT, OWNED HERE AND NOWHERE ELSE. Given what a region reads (`of`) and the name its look is remembered
// under (`imprint`), this decides every frame of the wait, so no view chooses them again:
// - nothing for a moment (a fast answer paints no placeholder), then the region as it last looked here, or the
//   `#fallback` until it has been seen once; held long enough to register once shown (useLoadingReveal);
// - the answer, and only the answer, is what the look is taken from, so a placeholder can never be taken for the region;
// - an answer that renders nothing is remembered as nothing, so a section that turned out empty is not promised again;
// - reads made inside the region as it first draws join its wait (`joinAwait`, which every daemon read does by itself),
//   and the region keeps its remembered look until they have answered or HOLD_BUDGET_MS has passed, instead of showing
//   its insides half-read. A region inside another joins it too, so a page settles once, not in pieces;
// - a wait that outlasts a blip says how long it has run, and offers to ask again;
// - a read that gave up is said, with a way to try again (`#failed` for a view's own words).

// Past this, the region draws with whatever has answered, and the reads still out are its own to draw: one slow read
// must not hide every quick one beside it.
const HOLD_BUDGET_MS = 2_500;
// A wait that ends in a moment says nothing about itself; past this, how long it has run is worth a look.
const SAY_ELAPSED_AFTER_MS = 5_000;

const { of, imprint, label } = defineProps<{
    of: Loaded<T>;
    /**
     * The name the region's look is remembered under, in the sandbox's store. Carry what the region is about when it
     * shows different things (`acceptance.stories:${repo}`), never something that changes on every visit. Without one
     * nothing is remembered: the fallback stands for every wait, and the region draws as soon as its answer is here.
     */
    imprint?: string | undefined;
    /** What a screen reader hears while the region waits; the kit's "Loading…" by default. */
    label?: string | undefined;
}>();

defineSlots<{
    default?(props: { readonly data: T; readonly refreshing: boolean; readonly refreshError: string | undefined }): VNode[];
    fallback?(): VNode[];
    failed?(props: { readonly error: string; readonly retry: (() => void) | undefined }): VNode[];
    idle?(): VNode[];
}>();

const t = useT();

// The reads inside, joined while they live.
const joined = shallowReactive(new Set<() => Loaded<unknown>>());
const inside = computed(() => [...joined].map((read) => read()).filter((read) => read.state === `waiting`));

// Whether the region has been shown since its answer came: latched, so a read started later (a dialog, a poll) never
// takes the region back, and reset only when the region is about something else or its own answer goes.
const released = ref(false);
let budget: ReturnType<typeof setTimeout> | undefined;
const release = (): void => {
    clearTimeout(budget);
    budget = undefined;
    released.value = true;
};
const settle = (): void => {
    if (released.value || of.state !== `ready`) {
        return;
    }
    if (imprint === undefined || inside.value.length === 0) {
        release();
        return;
    }
    budget ??= setTimeout(release, HOLD_BUDGET_MS);
};
const rearm = (): void => {
    clearTimeout(budget);
    budget = undefined;
    released.value = false;
};
// "About something else" is a new name AND a new answer. A region whose answer stays the one it drew (a route's view,
// whose sections are different pages remembered apart) has insides that own their waits, so a new name alone only
// changes what its look is remembered under: re-holding it there drew the hub's whole outline, rail and title, over a
// mounted hub on every move to a section not yet seen. A new answer under the same name is a refresh (a poll), which
// never takes the region back either.
const answer = (): T | undefined => (of.state === `ready` ? of.data : undefined);
watch(
    () => [imprint, answer(), of.state === `ready`] as const,
    ([name, data, ready], previous) => {
        if (previous !== undefined && (!ready || (previous[0] !== name && previous[1] !== data))) {
            rearm();
        }
    },
);
// After the render that mounted the insides (they join as they set up), never in the middle of it.
watch(() => [of.state, inside.value.length] as const, settle, { flush: `post` });
onMounted(settle);
onBeforeUnmount(() => clearTimeout(budget));

const holding = computed(() => of.state === `ready` && !released.value);
const waiting = computed(() => of.state === `waiting` || holding.value);
const subject = computed(() => imprint ?? ``);
const revealed = useLoadingReveal(waiting, subject);

// The region's own wait, joined to the region it sits in, which holds until this one has settled too.
const since = computed(() =>
    of.state === `waiting` ? of.since : Math.min(Date.now(), ...inside.value.map((read) => (read.state === `waiting` ? read.since : Date.now()))),
);
const retry = computed(() => (of.state === `waiting` || of.state === `failed` ? of.retry : undefined));
joinAwait(() => (waiting.value ? { state: `waiting`, since: since.value, retry: retry.value } : { state: `idle` }));
provide(AWAIT_SCOPE, { join: (read) => joined.add(read), leave: (read) => joined.delete(read) });

// The insides stay mounted under the placeholder, so the reads they make keep going; they are shown once nothing holds
// them and the placeholder has been up long enough to register.
const hidden = computed(() => holding.value || revealed.value);
// Taken only from the answer on screen: a hidden region measures as nothing, and must not be remembered as nothing.
const source = computed(() => (hidden.value ? undefined : imprint));

const now = useNow(() => revealed.value && of.state === `waiting`);
const elapsed = computed(() =>
    of.state === `waiting` && now.value - of.since >= SAY_ELAPSED_AFTER_MS ? formatElapsed((now.value - of.since) / 1000) : undefined,
);
const spoken = computed(() => label ?? t(`ui.status.loading`));
</script>

<template>
    <!-- A slot the view gave is the view's word, even an empty one (its own notice already says it): never the default. -->
    <template v-if="of.state === `failed`">
        <slot v-if="$slots[`failed`]" name="failed" :error="of.error" :retry="of.retry" />
        <Notice
            v-else
            :of="{
                tone: `danger`,
                title: t(`ui.await.couldntLoad`),
                detail: of.error,
                action: of.retry === undefined ? undefined : { label: t(`ui.action.tryAgain`), run: of.retry },
            }"
        />
    </template>
    <slot v-else-if="of.state === `idle`" name="idle" />
    <template v-else>
        <template v-if="revealed">
            <SkeletonSnapshot v-if="imprint !== undefined" :of="imprint" :label="spoken">
                <slot v-if="$slots[`fallback`]" name="fallback" />
                <div v-else role="status" aria-busy="true" :aria-label="spoken"><SkeletonRows /></div>
            </SkeletonSnapshot>
            <slot v-else-if="$slots[`fallback`]" name="fallback" />
            <div v-else role="status" aria-busy="true" :aria-label="spoken"><SkeletonRows /></div>
            <!-- After the placeholder, never before it: the region's predicted look must not move when a wait runs long.
                 A row of its own in a grid, where it would otherwise take one of the region's cells. -->
            <p v-if="elapsed !== undefined" key="elapsed" class="col-span-full flex items-center gap-2 pt-2 text-2xs text-muted" role="status">
                <span class="tabular-nums">{{ t(`ui.await.stillWaiting`, { elapsed }) }}</span>
                <button v-if="retry !== undefined" type="button" class="text-link hover:underline" @click="retry()">
                    {{ t(`ui.action.tryAgain`) }}
                </button>
            </p>
        </template>
        <div v-if="of.state === `ready`" key="answer" v-skeleton-source.empty="source" class="contents">
            <div :class="hidden ? `hidden` : `contents`">
                <slot :data="of.data" :refreshing="of.refreshing" :refresh-error="of.refreshError" />
            </div>
        </div>
    </template>
</template>
