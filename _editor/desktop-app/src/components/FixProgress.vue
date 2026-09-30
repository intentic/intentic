<script setup lang="ts">
import { Button, type IconName, Notice } from "@intentic/ui";
import { computed } from "vue";
import { consentChecks, type FixView, troubled, verdictOf } from "../fixReport";
import { useT } from "@intentic/ui/i18n";

// `ic sandbox fix`, while it runs and once it has ended (src-tauri/src/fix.rs runs it, fixReport.ts reads its lines):
// what it is doing now, every check it has named with its state, then the verdict and one button for each fix that
// waits on the user's yes. `ic` reports the same run to the platform itself, which is how the recovery panel that
// asked for it follows along; nothing here speaks to the platform.

const t = useT();

const props = defineProps<{
    view: FixView;
    /** The sandbox's name as this app remembers it, else its slug. */
    name: string;
    /** Held until the run already going on this device ends. */
    queued: boolean;
    /** It never ran: no `ic` on this device, or one would not start. */
    failure?: string;
    /** How long a run may take before the app stops it, in minutes (fix.rs `LIMIT`). */
    limitMinutes: number;
    /** Another run on this device is going, so a yes would have to wait for it. */
    busy: boolean;
}>();
const emit = defineEmits<{ accept: [id: string]; dismiss: [] }>();

const verdict = computed(() => verdictOf(props.view));
const running = computed(() => props.failure === undefined && verdict.value.kind === `running`);
const accepts = computed(() => (props.failure === undefined ? consentChecks(props.view) : []));

// What it is doing now: `ic`'s own words while it has some, else its stage in ours.
const now = computed(() => {
    if (props.queued) {
        return t(`desktop.fix.waitingForOtherRun`);
    }
    if (props.view.doing !== undefined) {
        return props.view.doing;
    }
    switch (props.view.stage) {
        case `checking`:
            return t(`desktop.fix.stageChecking`);
        case `fixing`:
            return t(`desktop.fix.stageFixing`);
        case `asking`:
            return t(`desktop.fix.stageAsking`);
        case `done`:
            return t(`desktop.fix.stageDone`);
        default:
            return t(`desktop.fix.stageStarting`);
    }
});

const outcomeHeading = (outcome: string | undefined, code: number | null): string => {
    switch (outcome) {
        case `healthy`:
            return t(`desktop.fix.healthy`, { sandbox: props.name });
        case `fixed`:
            return t(`desktop.fix.fixed`, { sandbox: props.name });
        case `needs-you`:
            return t(`desktop.fix.needsYou`);
        case `failed`:
            return t(`desktop.fix.failed`);
        // No word, or one this app does not know yet: the exit code is the verdict.
        default:
            return code === 0 ? t(`desktop.fix.finished`) : t(`desktop.fix.somethingLeft`);
    }
};

const heading = computed(() => {
    const shown = verdict.value;
    if (props.failure !== undefined) {
        return t(`desktop.fix.didntStart`);
    }
    if (shown.kind === `running`) {
        return t(`desktop.fix.fixing`, { sandbox: props.name });
    }
    if (shown.kind === `unsupported`) {
        return t(`desktop.fix.icCantFixYet`);
    }
    if (shown.kind === `stopped`) {
        return t(`desktop.fix.stopped`);
    }
    return outcomeHeading(shown.outcome, shown.code);
});

// All well: said in the heading's own line, with nothing to act on.
const settled = computed(() => {
    const shown = verdict.value;
    return shown.kind === `ended` && shown.code === 0 && (shown.outcome === undefined || shown.outcome === `healthy` || shown.outcome === `fixed`);
});

// What is left, when the heading alone does not say it.
const note = computed(() => {
    if (props.failure !== undefined) {
        return props.failure;
    }
    const shown = verdict.value;
    switch (shown.kind) {
        case `unsupported`:
            return t(`desktop.fix.updateIc`);
        case `stopped`:
            return t(`desktop.fix.ranTooLong`, { minutes: props.limitMinutes });
        case `ended`:
            if (shown.next === `restart`) {
                return t(`desktop.fix.restartToFinish`);
            }
            if (shown.next === `consent` || accepts.value.length > 0) {
                return t(`desktop.fix.needsYourYes`);
            }
            return undefined;
        default:
            return undefined;
    }
});
// `ic`'s own last words, under the note, for a run that gave no report to explain itself with.
const evidence = computed(() => (props.failure === undefined && verdict.value.kind === `unsupported` ? props.view.said.join(`\n`) : ``));

// A state this app does not know, or none yet, is a plain circle in the quietest ink.
const iconOf = (state: string): IconName => {
    switch (state) {
        case `ok`:
            return `check-circle`;
        case `warn`:
            return `exclamation-triangle`;
        case `fail`:
            return `times-circle`;
        case `fixing`:
            return `spinner`;
        default:
            return `circle`;
    }
};
const toneOf = (state: string): string => {
    switch (state) {
        case `ok`:
            return `text-success`;
        case `warn`:
            return `text-warning`;
        case `fail`:
            return `text-danger`;
        case `fixing`:
            return `text-link`;
        default:
            return `text-subtle`;
    }
};

// A state in words beside its icon, so the list does not rest on colour; none for `ok`, which the icon says plainly.
const stateWord = (state: string): string | undefined => {
    switch (state) {
        case `ok`:
        case ``:
            return undefined;
        case `warn`:
            return t(`desktop.fix.stateWarn`);
        case `fail`:
            return t(`desktop.fix.stateFail`);
        case `fixing`:
            return t(`desktop.fix.stateFixing`);
        case `skip`:
            return t(`desktop.fix.stateSkip`);
        // A state a later `ic` added: its own word.
        default:
            return state;
    }
};
</script>

<template>
    <section class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4" :aria-busy="running">
        <div class="flex items-start gap-2.5">
            <Icon v-if="running" name="spinner" spin class="mt-0.5 shrink-0 text-link" />
            <Icon v-else-if="settled" name="check-circle" class="mt-0.5 shrink-0 text-success" />
            <Icon v-else name="wrench" class="mt-0.5 shrink-0 text-primary-400" />
            <div class="min-w-0 flex-1">
                <h3 class="text-sm leading-tight font-semibold">{{ heading }}</h3>
                <p v-if="running" class="mt-0.5 text-2xs text-subtle" role="status">{{ now }}</p>
            </div>
            <!-- A run keeps going until it ends by itself or at its limit, so there is nothing to dismiss while it runs. -->
            <Button v-if="!running" size="small" severity="secondary" :text="true" class="-my-1 shrink-0" @click="emit(`dismiss`)">
                {{ t(`ui.action.dismiss`) }}
            </Button>
        </div>

        <!-- Every check ic has named, in its order, each with the state it last said; what is wrong and what closes it only where something is. -->
        <ul v-if="view.checks.length > 0" class="flex flex-col gap-2">
            <li v-for="check in view.checks" :key="check.id" class="flex items-start gap-2.5">
                <Icon
                    :name="iconOf(check.state)"
                    :spin="check.state === `fixing`"
                    class="mt-0.5 shrink-0 text-xs"
                    :class="toneOf(check.state)"
                    aria-hidden="true"
                />
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div class="flex flex-wrap items-baseline gap-x-2">
                        <span class="text-xs" :class="check.state === `skip` ? `text-subtle` : `text-content`">{{ check.label }}</span>
                        <span v-if="stateWord(check.state)" class="text-2xs text-subtle">{{ stateWord(check.state) }}</span>
                    </div>
                    <p v-if="troubled(check) && check.problem" class="text-2xs leading-relaxed text-muted">{{ check.problem }}</p>
                    <p v-if="troubled(check) && check.remedy" class="text-2xs leading-relaxed text-subtle">{{ check.remedy }}</p>
                </div>
            </li>
        </ul>

        <Notice v-if="note" :tone="failure !== undefined ? `danger` : `warning`" class="items-start text-2xs">
            <span class="block">{{ note }}</span>
            <span v-if="evidence" class="mt-1 block font-mono break-words whitespace-pre-line text-subtle">{{ evidence }}</span>
        </Notice>

        <!-- One yes per fix ic can make once someone agrees: the click that stands in for the terminal it would have asked in. -->
        <div v-if="!running && accepts.length > 0" class="flex flex-wrap items-center gap-2">
            <Button v-for="check in accepts" :key="check.id" size="small" :label="check.label" :disabled="busy" @click="emit(`accept`, check.id)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </div>
    </section>
</template>
