<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { formatDateLong, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import type { EngineMoveEnd, EngineStatus, MoveTarget } from "../desktop";
import { barOf, gigabytes, keptCopiesOf, moveTargetOf, offerOf, pcEngineOf, type MoveProgress } from "../device/engineMove";

// WHICH ENGINE THIS PC'S SANDBOXES RUN ON, beside Docker's own card on This device (device/engine.ts holds it, the app's
// engine.rs runs `ic engine`): Docker Desktop or Intentic's engine, and the move to the other one. On Docker Desktop the
// move is in reach with a line of why and of what happens, and in front of the reader with a "Not now" once ic says it
// is worth making; on Intentic's engine the way back is a quiet link. While a move runs, which sandbox it is on, its step
// and its bytes; after, how it ended. The copies a move left behind are said with their day, and can go sooner.

const t = useT();

const props = defineProps<{
    status: EngineStatus;
    /** A move under way, this window's or another's. */
    progress?: MoveProgress;
    /** How the last move ended. */
    end?: EngineMoveEnd;
    /** A move asked for here that never ran. */
    error?: string;
    /** Another run on this device is going: a move waits for it. */
    busy: boolean;
    /** The copies are being removed. */
    cleaning: boolean;
    cleanupNote?: string;
    offerError?: string;
    /** The name this app knows a sandbox by, else its slug. */
    nameOf: (slug: string) => string;
}>();
const emit = defineEmits<{ move: [to: MoveTarget, offered: boolean]; decline: []; cleanup: []; dismiss: []; log: [path: string]; shown: [] }>();

const moving = computed(() => props.progress !== undefined);
// Where a move that just finished went, until the status read after it says so too: for that second the card says where
// the sandboxes are now, and offers no move from where they were.
const movedTo = computed(() => (props.end?.outcome === `moved` ? pcEngineOf(props.end.engine) : undefined));
const caughtUp = computed(() => movedTo.value === undefined || movedTo.value === props.status.engine);
const engine = computed(() => (caughtUp.value ? pcEngineOf(props.status.engine) : movedTo.value));
const offer = computed(() => (caughtUp.value ? offerOf(props.status) : `none`));
const target = computed(() => moveTargetOf(props.status));
// In front of the reader: the offer, a move under way, and how one ended. Otherwise a quiet line among the rest.
const prominent = computed(() => moving.value || props.end !== undefined || props.error !== undefined || offer.value === `offer`);

// Said each time the card turns to the offer; the store counts it once a window.
watch(
    () => offer.value === `offer` && !moving.value,
    (offered) => {
        if (offered) {
            emit(`shown`);
        }
    },
    { immediate: true },
);

const heading = computed(() => {
    if (props.progress !== undefined) {
        return t(`desktop.engine.movingTo.${props.progress.to ?? `other`}`);
    }
    return offer.value === `offer` ? t(`desktop.engine.offerTitle`) : t(`desktop.engine.runsOn.${engine.value ?? `intentic`}`);
});

const lead = computed(() => {
    if (moving.value) {
        return t(`desktop.engine.whileMoving`);
    }
    switch (offer.value) {
        case `offer`:
        case `optIn`:
            return t(`desktop.engine.why`);
        case `gpu`:
            return t(`desktop.engine.gpu`);
        default:
            return engine.value === `intentic` ? t(`desktop.engine.keptRunning`) : undefined;
    }
});

/* A MOVE UNDER WAY: which sandbox, which step, how many bytes, and a bar that fills where the step can say how far. */
const bar = computed(() => (props.progress === undefined ? undefined : barOf(props.progress)));
const stepLabel = computed(() => {
    const progress = props.progress;
    if (progress === undefined) {
        return ``;
    }
    if (progress.step === undefined) {
        return progress.install === undefined ? t(`desktop.engine.step.begin`) : t(`desktop.engine.step.engine`);
    }
    const step = t(`desktop.engine.step.${progress.step}`);
    return progress.slug === undefined ? step : `${props.nameOf(progress.slug)} · ${step}`;
});
const position = computed(() => {
    const progress = props.progress;
    return progress?.index === undefined || progress.count === undefined || progress.count < 2
        ? undefined
        : t(`desktop.engine.position`, { index: progress.index + 1, count: progress.count });
});
const bytes = computed(() => {
    const progress = props.progress;
    if (progress === undefined || (progress.step !== `image` && progress.step !== `volume`) || progress.done === undefined) {
        return undefined;
    }
    const done = gigabytes(progress.done);
    if (progress.total === undefined || progress.total === 0) {
        return t(`desktop.engine.copiedSoFar`, { done });
    }
    // An image's size is ic's estimate before it is saved, so it is said as one.
    return progress.step === `image`
        ? t(`desktop.engine.copiedAbout`, { done, total: gigabytes(progress.total) })
        : t(`desktop.engine.copied`, { done, total: gigabytes(progress.total) });
});

/* THE COPIES A MOVE LEFT, by the engine that keeps them. */
const copies = computed(() => keptCopiesOf(props.status));
</script>

<template>
    <section
        class="flex flex-col gap-3 rounded-xl p-4"
        :class="prominent ? `bg-card shadow-sm` : `border border-line`"
        :aria-busy="moving"
    >
        <header class="flex items-start gap-2.5">
            <Icon v-if="moving" name="spinner" spin class="mt-0.5 shrink-0 text-link" />
            <Icon v-else-if="offer === `gpu`" name="cpu" class="mt-0.5 shrink-0 text-subtle" />
            <Icon v-else-if="offer === `offer`" name="arrows-h" class="mt-0.5 shrink-0 text-link" />
            <Icon v-else name="boxes" class="mt-0.5 shrink-0 text-subtle" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ heading }}</h2>
                <p v-if="lead" class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ lead }}</p>
                <!-- What a move does, said before the press: the dialog asks again, but this is where the choice is made. -->
                <p v-if="!moving && (offer === `offer` || offer === `optIn`)" class="mt-1 max-w-read-sm text-2xs leading-relaxed text-subtle">
                    {{ t(`desktop.engine.what`) }}
                </p>
            </div>
        </header>

        <!-- Under way: a bar that fills for what can say how far, and moves on regardless for what cannot. -->
        <template v-if="progress">
            <div
                class="h-1.5 overflow-hidden rounded-full bg-content/15"
                role="progressbar"
                :aria-valuenow="bar"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="heading"
            >
                <span v-if="bar !== undefined" class="block h-full rounded-full bg-link transition-[width] duration-700 ease-out" :style="{ width: `${bar}%` }" />
                <span v-else class="block h-full w-full rounded-full bg-link/50 motion-safe:animate-pulse" />
            </div>
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs">
                <span class="min-w-0 flex-1 truncate text-content" v-tooltip.top="progress.install?.sentence">{{ stepLabel }}</span>
                <span v-if="bytes" class="shrink-0 tabular-nums text-subtle">{{ bytes }}</span>
                <span v-else-if="bar !== undefined && progress.step === undefined" class="shrink-0 tabular-nums text-subtle">{{ formatPercent(bar) }}</span>
                <span v-if="position" class="shrink-0 text-subtle">{{ position }}</span>
            </div>
            <p class="text-2xs text-subtle">{{ t(`desktop.engine.keepsGoing`) }}</p>
        </template>

        <!-- How the last move ended: the engine it is on now, or why it stopped and where that left the sandboxes. -->
        <Notice
            v-if="end?.outcome === `moved`"
            tone="info"
            icon="check-circle"
            class="text-xs"
            :dismiss-label="t(`ui.action.dismiss`)"
            @dismiss="emit(`dismiss`)"
        >
            {{ t(`desktop.engine.moved.${engine ?? `intentic`}`) }}
        </Notice>
        <Notice v-else-if="end?.outcome === `busy`" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            {{ t(`desktop.engine.busy`) }}
        </Notice>
        <Notice v-else-if="end?.outcome === `failed`" tone="danger" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            <span class="block font-medium">{{ t(`desktop.engine.didntFinish`) }}</span>
            <span v-if="end.reason" class="mt-0.5 block font-mono text-2xs break-words">{{ end.reason }}</span>
            <span class="mt-1 block">{{ end.putBack ? t(`desktop.engine.putBack`) : t(`desktop.engine.stoppedPartWay`) }}</span>
            <button v-if="end.log" type="button" :class="ui.textButton({ tone: `quiet` }, `mt-1`)" @click="emit(`log`, end.log)">
                {{ t(`desktop.engine.showLog`) }}
            </button>
        </Notice>
        <Notice v-else-if="error" tone="danger" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            <span class="block font-medium">{{ t(`desktop.engine.didntStart`) }}</span>
            <span class="mt-0.5 block font-mono text-2xs break-words">{{ error }}</span>
        </Notice>

        <!-- The move, at the reader's word: in front of them with "Not now" when ic says it is worth making, else in reach. -->
        <div v-if="!moving && (offer === `offer` || offer === `optIn`) && target" class="flex flex-wrap items-center gap-2">
            <Button
                size="small"
                :tier="offer === `offer` ? `accent` : `boring`"
                :label="t(`desktop.engine.moveToIntentic`)"
                :disabled="busy"
                @click="emit(`move`, target, offer === `offer`)"
            >
                <template #icon><Icon name="arrows-h" /></template>
            </Button>
            <Button v-if="offer === `offer`" size="small" tier="quiet" :label="t(`desktop.engine.notNow`)" :disabled="busy" @click="emit(`decline`)" />
        </div>
        <Notice v-if="offerError" tone="warning" class="text-2xs">{{ offerError }}</Notice>
        <!-- The way back, quietly: Docker Desktop is still installed, and moving back is a move like any other. -->
        <div v-if="!moving && offer === `back` && target">
            <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="busy" @click="emit(`move`, target, false)">
                <Icon name="arrows-h" class="shrink-0" />
                <span>{{ t(`desktop.engine.moveBack`) }}</span>
            </button>
        </div>

        <!-- What the engine left behind keeps: until the day ic removes it by itself, or now. -->
        <div v-if="copies.length > 0 && !moving" class="flex flex-col gap-1.5 border-t border-line pt-2.5">
            <p v-for="kept in copies" :key="kept.on" class="flex items-start gap-1.5 text-2xs text-subtle">
                <Icon name="history" class="mt-0.5 shrink-0" />
                <span>{{ t(`desktop.engine.kept.${kept.on}`, { date: formatDateLong(kept.until) }, kept.count) }}</span>
            </p>
            <div>
                <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="cleaning || busy" @click="emit(`cleanup`)">
                    <Icon :name="cleaning ? `spinner` : `trash`" :spin="cleaning" class="shrink-0" />
                    <span>{{ cleaning ? t(`desktop.engine.removing`) : t(`desktop.engine.removeNow`) }}</span>
                </button>
            </div>
            <Notice v-if="cleanupNote" tone="warning" class="text-2xs">{{ cleanupNote }}</Notice>
        </div>
    </section>
</template>
