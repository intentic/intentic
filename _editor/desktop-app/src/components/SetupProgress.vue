<script setup lang="ts">
import { Notice, ui } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import type { RunEvent } from "../desktop";
import type { ProgressView } from "../setupPlan";
import { useT } from "@intentic/ui/i18n";

// ONE THING IS HAPPENING, AND THIS SAYS WHICH. The step under way is the only sentence at reading size; the plan
// behind it is the bar's own divisions (setupPlan.ts weights it in seconds, so the long steps are visibly long),
// and the ten named rows are one click away for whoever wants them.
//
// `awaiting` is a deliberate stop for the requirements card above; this component just must not call it a crash.
// `blocked`: that card is on screen, so this one is not the thing to read.
const t = useT();

const props = defineProps<{ events: RunEvent[]; view: ProgressView; running: boolean; reason?: string; awaiting?: boolean; blocked?: boolean }>();

// Owned by the card's own action bar (App.vue), which holds every other verb about this transcript.
const open = defineModel<boolean>(`open`, { default: false });
const listOpen = ref(false);
const logEnd = ref<HTMLElement | undefined>(undefined);

const lines = computed(() => props.events.flatMap((event) => (event.kind === `line` ? [event] : [])));
const exit = computed(() => props.events.find((event) => event.kind === `exit`));
const stoppedShort = computed(() => exit.value?.kind === `exit` && !exit.value.ok);
// A non-zero exit isn't automatically a failure: a Windows install's first pass exits non-zero by design (it
// reports what it would change and stops), which App.vue also accounts for. Nor is one with a requirements card
// above it explaining what to do: that card is the message, and a red bar and a log under it would be this
// screen calling its own instructions a crash.
const failed = computed(() => !props.awaiting && props.blocked !== true && stoppedShort.value);
// The run is parked on something the reader has to answer, whether the script asked (`awaiting`) or stopped on a
// requirement the card above holds.
const parked = computed(() => props.awaiting === true || (props.blocked === true && stoppedShort.value));
// The estimate is shown only while the run is the thing that is moving.
const live = computed(() => props.running && !props.awaiting);
const done = computed(() => props.view.steps.every((step) => step.state === `done`));

// The step the run is in: the running one, or — once it has stopped — the first one it never finished.
const at = computed(() => props.view.steps.find((step) => step.state === `running`) ?? props.view.steps.find((step) => step.state !== `done`));
// Nothing has reported yet: the first step is next, not under way.
const started = computed(() => props.view.steps.some((step) => step.state !== `waiting`));
// Survives a stop, unlike `view.position`, which is the wire report's and goes quiet the moment a run ends.
const position = computed(() =>
    at.value === undefined ? undefined : `Step ${props.view.steps.indexOf(at.value) + 1} of ${props.view.steps.length}`,
);
const heading = computed(() => {
    const step = at.value;
    if (parked.value) {
        return `Waiting for you`;
    }
    if (failed.value) {
        // The step is named on the line under this one, so this says where in the plan rather than repeating it.
        return step === undefined ? `Stopped` : `Stopped at ${position.value?.toLowerCase() ?? `this step`}`;
    }
    if (step === undefined || done.value) {
        return `All done`;
    }
    if (!started.value) {
        return `Getting started`;
    }
    return step.label;
});

// Where one step ends and the next begins, as a fraction of the bar; the last boundary is the bar's own end and
// would draw a notch on the rounded cap, so it is left off.
const marks = computed(() => {
    let sum = 0;
    return props.view.steps.slice(0, -1).map((step) => {
        sum += step.share;
        return sum;
    });
});
// The bar's one colour: the ember while it moves, and the status the run ended on.
const fillClass = computed(() => (failed.value ? `bg-danger` : parked.value ? `bg-warning` : `bg-primary-fill`));

// Filters PowerShell's error-record furniture (source excerpt, CategoryInfo, FullyQualifiedErrorId) so a "last N
// lines of stderr" rule shows the actual message, not boilerplate.
const isPowerShellDecoration = (text: string): boolean => /^\s*\+ /.test(text) || /^At .+:\d+ char:\d+$/.test(text);

// Shows only the failure's own words: what went wrong, not where (the heading covers that). The `error:` a CLI
// prints for a terminal is dropped: on this screen the red border already says it, and the sentence after it is
// written for a person.
const failure = computed(() =>
    lines.value
        .filter((line) => line.stream === `stderr` && line.text.trim() !== `` && !isPowerShellDecoration(line.text))
        .slice(-4)
        .map((line) => line.text.replace(/^\s*error:\s+/i, ``))
        .join(`\n`),
);
// The stderr tail carries the reason where there is one; `reason` covers a command that failed without printing.
const told = computed(() => (failure.value === `` ? (props.reason ?? ``) : failure.value));

// immediate: a card mounting on an already-failed run opens the log too, not just future failures.
watch(
    failed,
    (value) => {
        if (value) {
            open.value = true;
        }
    },
    { immediate: true },
);
watch(
    () => lines.value.length,
    async () => {
        if (!open.value) {
            return;
        }
        await nextTick();
        logEnd.value?.scrollIntoView({ block: `end` });
    },
);
</script>

<template>
    <!-- ONE PRIMARY OBJECT PER SCREEN: with the requirements card up, this is not the thing to read, so it gives up
         its plate, its bar and its sentence and keeps only where the run is parked. -->
    <section :class="blocked ? `flex flex-col gap-3` : `entry-card flex flex-col gap-3 p-4`">
        <!-- The one sentence at reading size: what this computer is doing right now. -->
        <div v-if="!blocked" class="flex items-start gap-3">
            <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <Icon v-if="failed" name="exclamation-circle" class="text-danger" />
                <Icon v-else-if="parked" name="exclamation-circle" class="text-warning" />
                <Icon v-else-if="done" name="check-circle" class="text-success" />
                <Icon v-else name="spinner" spin class="text-link" />
            </span>
            <div class="min-w-0 flex-1">
                <p class="text-sm leading-snug font-medium text-content">{{ heading }}</p>
                <!-- The script's own line for this step, which is often an instruction rather than decoration. -->
                <p v-if="failed && at" class="mt-0.5 truncate text-xs text-muted">{{ at.label }}</p>
                <p v-else-if="at?.detail" class="mt-0.5 truncate text-xs text-muted">{{ at.detail }}</p>
            </div>
        </div>

        <!-- THE PLAN IS THE BAR: one whisper of a division per step, spaced by how long that step takes, so the
             shape of the wait is visible without ten rows of it being counted. -->
        <div
            v-if="!blocked"
            class="relative h-1.5 overflow-hidden rounded-full bg-content/15"
            role="progressbar"
            :aria-valuenow="view.percent"
            aria-valuemin="0"
            aria-valuemax="100"
        >
            <span
                class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
                :class="fillClass"
                :style="{ width: `${view.percent}%` }"
            />
            <span v-for="mark in marks" :key="mark" class="absolute inset-y-0 w-px bg-canvas/35" :style="{ left: `${mark * 100}%` }" />
        </div>

        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-subtle">
            <span v-if="position && !done && !failed">{{
                blocked ? t(`desktop.setupProgress.pausedAt`, { toLowerCase: position.toLowerCase() }) : position
            }}</span>
            <span v-if="live && view.remaining">{{ view.remaining }}</span>
            <span class="flex-1" />
            <button type="button" :class="ui.textAction(`shrink-0`)" @click="listOpen = !listOpen">
                {{ listOpen ? t(`desktop.setupProgress.hideSteps`) : t(`desktop.setupProgress.seeAllSteps`, { count: view.steps.length }) }}
            </button>
        </div>

        <!-- Steps that won't run on this machine were never in the plan; nothing here is crossed out or skipped. -->
        <ol v-if="listOpen" class="flex flex-col gap-1.5 border-t border-line pt-3">
            <li v-for="step in view.steps" :key="step.phase" class="flex items-start gap-2.5 text-xs">
                <span class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                    <Icon v-if="step.state === `done`" name="check" class="text-success" />
                    <Icon v-else-if="step.state === `running`" name="spinner" spin class="text-link" />
                    <!-- Neither done nor coming: a run that stopped is not still working through its list. -->
                    <span v-else class="size-1 rounded-full bg-current opacity-40" />
                </span>
                <span :class="step.state === `running` ? `min-w-0 flex-1 text-content` : `min-w-0 flex-1 text-subtle`">{{ step.label }}</span>
            </li>
        </ol>

        <!-- Prose, not a terminal: the log below is where the machine's own words are, one click away. -->
        <Notice v-if="failed && told !== ``" tone="danger" class="text-xs whitespace-pre-wrap">{{ told }}</Notice>

        <!-- Monospace and wrapped: it matches what the same command prints in a terminal, minus the sideways drag. -->
        <pre
            v-if="open"
            class="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed break-words text-muted whitespace-pre-wrap"
        ><span v-for="(line, index) in lines" :key="index" :class="line.stream === `stderr` ? `text-warning` : ``">{{ line.text }}
</span><span ref="logEnd" /></pre>
    </section>
</template>
