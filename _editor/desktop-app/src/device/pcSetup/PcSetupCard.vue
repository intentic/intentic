<script setup lang="ts">
import { Button, formatBytes, type IconName, Notice, toneInk, toneTint, toneWash, ui } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { LOCAL_NAVIGATE_EVENT } from "@intentic/web/local";
import { type LocalCheckRow, type LocalFirstTask, localHost, type LocalRestartWhen } from "@intentic/web/local-host";
import { computed, ref, watch } from "vue";
import { firstTaskTakeDraft, onboardingSignOut, signIn } from "../../desktop";
import { draft } from "../../onboarding/firstTask";
import { machineSandbox } from "../machineSandbox";
import FirstTaskComposer from "./FirstTaskComposer.vue";
import PcPrefetch from "./PcPrefetch.vue";
import PcStep from "./PcStep.vue";
import { pcCard } from "./livePcCard";
import { checksPassed, minutesLeft, offersWork, type PcCardPhase, pcSteps, type TaskKind, taskStart, unmetRows } from "./pcCard";

// THIS PC'S OWN SETUP, ON THIS COMPUTER (pcCard.ts says when and why): the way to agents on a new Windows PC, as three
// steps under one heading that says what they are for (pcCard.ts `pcSteps`, 2026-10-13). Prepare this PC: what it still
// needs, the one "Set up this PC" that does it and how far it is, the restart it asks for. Sign in. Give agents a first
// task, written meanwhile. A PC that cannot run agents, or a check that could not say, is told so under the same heading
// with no steps. Only what is still to do is listed: what is already fine is one line. Every press goes to the app
// (onboarding/pc.ts), which answers through the state drawn here; what it refuses outright is said at the card's foot.

const t = useT();
const host = localHost();
const onboarding = host.onboarding;

const phase = pcCard;
const check = computed(() => onboarding?.check.value);
const setup = computed(() => onboarding?.setup.value ?? { state: `idle` as const });
const firstTask = computed(() => onboarding?.firstTask.value);
const signedOut = computed(() => machineSandbox.value?.state === `signedOut`);
const working = computed(() => offersWork(phase.value));

// One ask of the app at a time, by what it is, and what it refused, in its own words (a folder gone since it was picked,
// a restart Windows would not do).
const busy = ref<string | undefined>(undefined);
const failure = ref<string | undefined>(undefined);
const ask = async (what: string, work: () => Promise<void>): Promise<void> => {
    if (busy.value !== undefined) {
        return;
    }
    busy.value = what;
    failure.value = undefined;
    try {
        await work();
    } catch (error) {
        // The app's refusals are sentences already written for the reader (local.rs, first_task.rs).
        failure.value = String(error);
    } finally {
        busy.value = undefined;
    }
};

// The setup itself is not waited on: the app answers once it ends, minutes later, and how it went is its own state
// above. Only a press it refused before starting is said here, never a failed run twice.
const runSetup = async (again: boolean): Promise<void> => {
    failure.value = undefined;
    try {
        await (again ? onboarding?.setUpAgain?.() : onboarding?.setUp());
    } catch (error) {
        if (setup.value.state !== `failed`) {
            failure.value = String(error);
        }
    }
};
// Not handed to the button as a promise, which would hold it pressed for the whole setup.
const startSetup = (again: boolean): void => {
    void runSetup(again);
};

/* THE STEPS: where each stands, from the phase, the sign-in and the first task. */

// Shown for a task sent long ago only when "Ask about this" began a new one (`draft`).
const drafted = ref(false);
// The first task's box opened by its own press, on a step that is open but not the next one.
const composing = ref(false);
const TASK_KIND = {
    queued: `kept`,
    sending: `kept`,
    sent: `sent`,
    failed: `failed`,
} as const satisfies Record<LocalFirstTask[`state`], TaskKind>;
const taskKind = computed((): TaskKind => {
    const kept = firstTask.value;
    if (drafted.value) {
        return `draft`;
    }
    return kept === undefined ? `none` : TASK_KIND[kept.state];
});
const steps = computed(() => {
    const found = pcSteps(phase.value, signedOut.value, taskKind.value);
    // A box opened by its own press (or a task taken back to edit, signed in or not) is the step being worked in.
    return composing.value && (found.task === `todo` || found.task === `locked`) ? { ...found, task: `current` as const } : found;
});

// What a step waiting on the reader, or stopped, is waiting for, beside its title in the marker's tone.
const STATE_WORD = {
    hidden: undefined,
    checking: undefined,
    checkUnknown: undefined,
    needsSetup: undefined,
    settingUp: undefined,
    restart: `restart`,
    admin: `admin`,
    signOut: `signOut`,
    setupFailed: `setupFailed`,
    cantRun: undefined,
    signIn: undefined,
    firstTaskFailed: undefined,
} as const satisfies Record<PcCardPhase, string | undefined>;
const stateWord = computed(() => {
    const word = STATE_WORD[phase.value];
    return word === undefined ? `` : t(`desktop.pcSetup.state.${word}`);
});
const stateTone = computed(() => toneInk(steps.value.pc === `failed` ? `danger` : `warning`));

// The machine and how much of the check it already passes, in one line, where the check is what is being shown.
const machineLine = computed(() => {
    const passed = checksPassed(check.value);
    const parts = [check.value?.machine, passed === undefined ? undefined : t(`desktop.pcSetup.passed`, { met: passed.met, total: passed.total })];
    return parts.filter((part): part is string => part !== undefined && part !== ``).join(` · `);
});

/* STEP 1, THIS PC: what is still to do, whose it is, and what setting it up costs. */

const todo = computed(() => unmetRows(check.value));
// Why the check could not say, as it said it (onboarding.rs: its one `check` row), for whoever looks into it.
const unknownWhy = computed(() => (phase.value === `checkUnknown` ? todo.value.find((row) => row.detail !== undefined)?.detail : undefined));
const blocked = computed(() => todo.value.filter((row) => row.state === `blocked`));
// The raw words behind a stopped setup or a check that could not say, behind a press: for whoever looks into it.
const detailsOpen = ref(false);

// Only what the reader has to do, or cannot, is marked: Intentic's own steps are the list's default.
const rowHint = (row: LocalCheckRow): string => {
    switch (row.state) {
        case `yours`:
            return t(`desktop.requirements.badge.youDoIt`);
        case `blocked`:
            return t(`desktop.requirements.badge.unsupported`);
        case `ours`:
        case `met`:
            return ``;
    }
};
const ROW_ICON = {
    ours: { name: `bolt`, tone: `text-link` },
    yours: { name: `user`, tone: `text-warning` },
    blocked: { name: `times`, tone: `text-danger` },
    met: { name: `check`, tone: `text-success` },
} as const satisfies Record<LocalCheckRow[`state`], { readonly name: IconName; readonly tone: string }>;

// What setting it up costs, as glyphs and a few words each rather than one sentence of them.
const cost = computed(() => {
    const found = check.value;
    if (found === undefined) {
        return [];
    }
    const parts: { readonly icon: IconName; readonly text: string }[] = [];
    if (found.minutes > 0) {
        parts.push({ icon: `clock`, text: t(`desktop.pcSetup.cost.minutes`, { count: found.minutes }) });
    }
    if (found.restart) {
        parts.push({ icon: `refresh`, text: t(`desktop.pcSetup.cost.restart`) });
    }
    if (found.downloadBytes > 0) {
        parts.push({ icon: `download`, text: t(`desktop.pcSetup.cost.download`, { size: formatBytes(found.downloadBytes) }) });
    }
    if (found.admin) {
        parts.push({ icon: `shield`, text: t(`desktop.pcSetup.cost.admin`) });
    }
    return parts;
});

// The app's quick asks, each answered through the state drawn here (a check reads again, a download pauses).
const recheck = (): Promise<void> => ask(`recheck`, async () => onboarding?.recheck());
const useCloud = (): Promise<void> => ask(`cloud`, async () => onboarding?.useCloud());
const showLog = (): Promise<void> => ask(`log`, async () => onboarding?.showSetupLog?.());
const pausePrefetch = (paused: boolean): Promise<void> => ask(`prefetch`, async () => onboarding?.pause(paused));
const retryPrefetch = (): Promise<void> => ask(`prefetch`, async () => onboarding?.retryPrefetch?.());
const signInNow = (): Promise<void> => ask(`signIn`, signIn);

/* THE SETUP AS IT RUNS: how far, what it is on, and what Windows is waiting for. */

const percent = computed(() => (setup.value.state === `running` ? Math.round(setup.value.percent) : 0));
const step = computed(() => (setup.value.state === `running` ? setup.value.step : undefined));
const needsYou = computed(() => setup.value.state === `running` && setup.value.needsYou === true);
// No line from the setup for twenty minutes or more (onboarding.rs `SETUP_STALL_AFTER`): what it was on, and a way on.
const quietMinutes = computed(() => (setup.value.state === `running` ? setup.value.quietMinutes : undefined));
const left = computed(() => minutesLeft(check.value, setup.value));

// A restart the reader put off ten minutes: when, by this computer's clock, in the reader's language.
const restartAt = computed(() =>
    setup.value.state === `waiting` && setup.value.restartAt !== undefined ? formatClock(setup.value.restartAt * 1000) : undefined,
);
const restart = (when: LocalRestartWhen): Promise<void> => ask(`restart`, async () => onboarding?.restart(when));

const failedReason = computed(() => (setup.value.state === `failed` ? setup.value.reason : undefined));
// Repair, the agent that runs on this computer outside every sandbox, opened on the failure (local shell `/repair`).
const askRepair = (): void => {
    const query = new URLSearchParams({ from: `setup` });
    if (failedReason.value !== undefined) {
        query.set(`reason`, failedReason.value);
    }
    window.dispatchEvent(new CustomEvent(LOCAL_NAVIGATE_EVENT, { detail: { path: `/repair?${query.toString()}` } }));
};

/* STEP 2, THE SIGN-IN: the next press once this PC is ready or its setup runs by itself, a press beside it before. */

const signInLine = computed(() => {
    if (!signedOut.value) {
        return t(`desktop.pcSetup.signIn.done`);
    }
    return steps.value.pc === `done` ? t(`desktop.pcSetup.signIn.now`) : t(`desktop.pcSetup.signIn.meanwhile`);
});

/* STEP 3, THE FIRST TASK: written here while the PC is set up, kept by the app until this computer's sandbox can take it. */

const folder = ref(``);
const text = ref(``);
// The box, or what it kept: open while the step is the next one, holds a task, or was opened by its own press.
const taskOpen = computed(
    () => onboarding !== undefined && taskKind.value !== `sent` && (steps.value.task === `current` || steps.value.task === `failed` || taskKind.value === `kept`),
);
const starts = computed(() => taskStart(phase.value, signedOut.value));
const taskLine = computed(() => {
    const state = steps.value.task;
    if (state === `locked`) {
        return t(`desktop.pcSetup.task.locked`);
    }
    if (state === `todo`) {
        return t(`desktop.pcSetup.task.later`);
    }
    if (state === `failed`) {
        return t(`desktop.pcSetup.task.failedTitle`);
    }
    if (state === `done`) {
        return taskKind.value === `sent` ? t(`desktop.pcSetup.task.sent`) : t(`desktop.pcSetup.task.keptTitle`);
    }
    return t(`desktop.pcSetup.task.lead`);
});

watch(
    firstTask,
    (kept) => {
        if (kept !== undefined && kept.state !== `sent`) {
            folder.value = kept.folder;
            text.value = kept.text;
        }
    },
    { immediate: true },
);

// The app's own copy of a draft this window heard as it was made, so a window opened later does not take it again.
const forgetDraft = async (): Promise<void> => {
    try {
        await firstTaskTakeDraft();
    } catch (error) {
        console.error(`[first task] the draft could not be taken:`, error);
    }
};

// "Ask about this" while no sandbox could answer (first_task.rs `prefill_from_ask`): its folder and opening words, in
// the box, unless a task is already kept there.
watch(
    draft,
    (begun) => {
        if (begun === undefined) {
            return;
        }
        draft.value = undefined;
        void forgetDraft();
        const kept = firstTask.value;
        if (kept !== undefined && kept.state !== `sent`) {
            return;
        }
        folder.value = begun.folder;
        text.value = begun.text;
        drafted.value = true;
    },
    { immediate: true },
);

const pickFolder = (): Promise<void> =>
    ask(`task`, async () => {
        const picked = await onboarding?.pickFolder();
        if (picked !== undefined) {
            folder.value = picked;
        }
    });
const queueTask = (): Promise<void> =>
    ask(`task`, async () => {
        await onboarding?.queueFirstTask({ folder: folder.value, text: text.value });
        drafted.value = false;
        composing.value = false;
    });
// Taken back to change: the box holds it again, and the app forgets it until it is queued anew.
const editTask = (): Promise<void> =>
    ask(`task`, async () => {
        const kept = firstTask.value;
        if (kept !== undefined) {
            folder.value = kept.folder;
            text.value = kept.text;
        }
        composing.value = true;
        await onboarding?.clearFirstTask();
    });
const retryTask = (): Promise<void> =>
    ask(`task`, async () => {
        const kept = firstTask.value;
        if (kept !== undefined) {
            await onboarding?.queueFirstTask({ folder: kept.folder, text: kept.text });
        }
    });
</script>

<template>
    <!-- Before the check has answered: one quiet line, which is gone in seconds on most launches. -->
    <p v-if="phase === `checking`" class="flex items-center gap-2.5 text-xs text-subtle">
        <Icon name="spinner" spin class="shrink-0 text-link" />
        <span>{{ t(`desktop.app.pcSetupChecking`) }}</span>
    </p>

    <section v-else-if="phase !== `hidden`" class="flex flex-col gap-5 rounded-xl bg-card p-5 shadow-sm">
        <!-- WHAT THIS IS FOR, before any step: agents, what they do, and where they run. -->
        <header class="flex items-start gap-3">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" :class="toneWash(`primary`)">
                <Icon name="robot" class="text-lg" />
            </span>
            <div class="min-w-0 flex-1">
                <h2 class="text-base leading-tight font-semibold text-content">{{ t(`desktop.pcSetup.title`) }}</h2>
                <p class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.pcSetup.lead`) }}</p>
            </div>
        </header>

        <!-- NO SANDBOX CAN RUN HERE: why, and a computer we host instead. No steps: none of them would lead anywhere. -->
        <div v-if="phase === `cantRun`" class="flex flex-col gap-3 rounded-lg border p-4" :class="toneTint(`neutral`, `soft`)">
            <div>
                <p class="text-sm font-medium text-content">{{ t(`desktop.pcSetup.cantRun.title`) }}</p>
                <p v-if="machineLine" class="mt-0.5 text-2xs text-subtle">{{ machineLine }}</p>
            </div>
            <ul v-if="blocked.length > 0" class="flex flex-col gap-2 text-xs">
                <li v-for="row in blocked" :key="row.id" class="flex items-start gap-2">
                    <Icon name="times" class="mt-0.5 shrink-0 text-2xs text-danger" aria-hidden="true" />
                    <div class="min-w-0 flex-1">
                        <p class="text-content">{{ row.label }}</p>
                        <p v-if="row.detail" class="text-2xs text-muted">{{ row.detail }}</p>
                    </div>
                </li>
            </ul>
            <p class="text-xs text-muted">{{ t(`desktop.pcSetup.hosted`) }}</p>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button size="small" :label="t(`desktop.pcSetup.cloud`)" :disabled="busy !== undefined" @click="useCloud">
                    <template #icon><Icon name="cloud" /></template>
                </Button>
                <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="busy !== undefined" @click="recheck">
                    <Icon v-if="busy === `recheck`" name="spinner" spin class="shrink-0" />
                    <span>{{ t(`desktop.requirements.checkAgain`) }}</span>
                </button>
            </div>
        </div>

        <!-- The check could not say: asked again, or the setup run anyway, which finds out for itself. -->
        <Notice v-else-if="phase === `checkUnknown`" tone="warning" class="text-xs">
            <span class="block">{{ t(`desktop.pcSetup.unknown`) }}</span>
            <span class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button size="small" tier="boring" :label="t(`desktop.requirements.checkAgain`)" :loading="busy === `recheck`" @click="recheck" />
                <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="startSetup(false)">{{ t(`desktop.app.setUpThisPc`) }}</button>
                <button v-if="unknownWhy" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="detailsOpen = !detailsOpen">
                    {{ detailsOpen ? t(`desktop.pcSetup.details.hide`) : t(`desktop.pcSetup.details.show`) }}
                </button>
            </span>
            <span v-if="unknownWhy && detailsOpen" class="mt-2 block font-mono break-words text-2xs">{{ unknownWhy }}</span>
        </Notice>

        <ol v-else-if="working" class="flex flex-col">
            <!-- 1. THIS PC: what it still needs and the one press that does it, how far it is, what it waits on. -->
            <PcStep :n="1" :state="steps.pc" :title="t(`desktop.pcSetup.pc.title`)">
                <template v-if="steps.pc !== `running`" #line>
                    <template v-if="steps.pc === `done`">
                        {{ t(`desktop.pcSetup.ready`) }}<template v-if="check?.machine"> · {{ check.machine }}</template>
                    </template>
                    <template v-else-if="phase === `needsSetup`">{{ t(`desktop.pcSetup.pc.line`) }}</template>
                </template>
                <template v-if="stateWord" #aside>
                    <span class="text-2xs font-medium" :class="stateTone">{{ stateWord }}</span>
                </template>

                <!-- WHAT IT STILL NEEDS: what is fine already in one line, then what Intentic does and what only the reader can. -->
                <template v-if="phase === `needsSetup`">
                    <ul class="flex flex-col gap-1.5 text-xs">
                        <li v-if="machineLine" class="flex items-start gap-2">
                            <Icon name="check" class="mt-0.5 shrink-0 text-2xs text-success" aria-hidden="true" />
                            <p class="min-w-0 flex-1 text-muted">{{ machineLine }}</p>
                        </li>
                        <li v-for="row in todo" :key="row.id" class="flex items-start gap-2">
                            <Icon :name="ROW_ICON[row.state].name" class="mt-0.5 shrink-0 text-2xs" :class="ROW_ICON[row.state].tone" aria-hidden="true" />
                            <div class="min-w-0 flex-1">
                                <p class="text-content">{{ row.label }}</p>
                                <!-- Only for what the reader has to do: Intentic's own steps need no explaining before they run. -->
                                <p v-if="row.state !== `ours` && row.detail" class="text-2xs text-muted">{{ row.detail }}</p>
                            </div>
                            <span v-if="rowHint(row)" class="shrink-0 text-2xs text-subtle">{{ rowHint(row) }}</span>
                        </li>
                    </ul>
                    <ul v-if="cost.length > 0" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
                        <li v-for="part in cost" :key="part.icon" class="flex items-center gap-1.5">
                            <Icon :name="part.icon" class="shrink-0 text-subtle" aria-hidden="true" />
                            <span>{{ part.text }}</span>
                        </li>
                    </ul>
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button size="small" :label="t(`desktop.app.setUpThisPc`)" @click="startSetup(false)">
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <!-- For what only the reader can change (a firmware setting, disk space, Docker installed by hand). -->
                        <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="busy !== undefined" @click="recheck">
                            <Icon v-if="busy === `recheck`" name="spinner" spin class="shrink-0" />
                            <span>{{ t(`desktop.requirements.checkAgain`) }}</span>
                        </button>
                    </div>
                </template>

                <!-- RUNNING: how far, on what, and how long is left; what Windows is asking for, when it is. -->
                <template v-else-if="phase === `settingUp`">
                    <div class="flex flex-col gap-1.5">
                        <div class="flex items-start gap-3 text-xs">
                            <!-- Windows' own prompt, in place of the step it holds up: said once, as what to do. -->
                            <span v-if="needsYou" class="flex min-w-0 flex-1 items-start gap-1.5 font-medium text-warning">
                                <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                                <span>{{ t(`desktop.pcSetup.needsYou`) }}</span>
                            </span>
                            <span v-else class="min-w-0 flex-1 truncate text-muted" v-tooltip.top="step">{{ step }}</span>
                            <span class="shrink-0 text-2xs tabular-nums text-subtle">
                                <template v-if="left !== undefined">{{ t(`desktop.pcSetup.minutesLeft`, { count: left }) }} · </template>{{ t(`desktop.machineSandbox.percent`, { percent }) }}
                            </span>
                        </div>
                        <div
                            class="h-1.5 overflow-hidden rounded-full bg-line"
                            role="progressbar"
                            :aria-valuenow="percent"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            :aria-label="t(`desktop.pcSetup.pc.title`)"
                        >
                            <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
                        </div>
                    </div>
                    <!-- The step it went quiet on is the line above the bar, which is not said twice. -->
                    <Notice v-if="quietMinutes !== undefined" tone="warning" class="text-xs">
                        <span class="block font-medium">{{ t(`desktop.pcSetup.quiet.title`, { count: quietMinutes }) }}</span>
                        <span class="mt-0.5 block">{{ t(`desktop.pcSetup.quiet.body`) }}</span>
                        <span class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                            <Button size="small" tier="boring" :label="t(`desktop.pcSetup.quiet.again`)" @click="startSetup(true)" />
                            <button v-if="onboarding?.showSetupLog" type="button" :class="ui.textButton({ tone: `quiet` })" @click="showLog">
                                {{ t(`desktop.machineSandbox.showLog`) }}
                            </button>
                        </span>
                    </Notice>
                </template>

                <!-- A RESTART FINISHES IT: now, in ten minutes, or the next time Windows starts. -->
                <template v-else-if="phase === `restart`">
                    <p class="max-w-read-sm text-xs leading-relaxed text-muted">
                        {{ t(`desktop.pcSetup.restart.body`) }} <span class="font-medium text-content">{{ t(`desktop.pcSetup.restart.save`) }}</span>
                    </p>
                    <p v-if="restartAt" class="flex items-center gap-1.5 text-xs font-medium text-content">
                        <Icon name="clock" class="shrink-0 text-warning" aria-hidden="true" />
                        <span>{{ t(`desktop.pcSetup.restart.at`, { time: restartAt }) }}</span>
                    </p>
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button size="small" :label="t(`desktop.requirements.restartNow`)" :disabled="busy !== undefined" @click="restart(`now`)">
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <template v-if="restartAt">
                            <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="busy !== undefined" @click="restart(`later`)">
                                {{ t(`desktop.pcSetup.restart.cancel`) }}
                            </button>
                        </template>
                        <template v-else>
                            <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="busy !== undefined" @click="restart(`in10Minutes`)">
                                {{ t(`desktop.pcSetup.restart.in10Minutes`) }}
                            </button>
                            <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="busy !== undefined" @click="restart(`later`)">
                                {{ t(`desktop.pcSetup.restart.later`) }}
                            </button>
                        </template>
                    </div>
                </template>

                <!-- Windows' permission prompt was closed or answered No: nothing changed, and the same press asks again. -->
                <template v-else-if="phase === `admin`">
                    <p class="max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.app.pcSetupAdminDeclined`) }}</p>
                    <Button class="self-start" size="small" :label="t(`desktop.app.setUpThisPc`)" @click="startSetup(false)">
                        <template #icon><Icon name="shield" /></template>
                    </Button>
                </template>

                <template v-else-if="phase === `signOut`">
                    <p class="max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.pcSetup.signOut`) }}</p>
                    <Button class="self-start" size="small" :label="t(`desktop.requirements.signOutNow`)" :disabled="busy !== undefined" @click="ask(`signOut`, onboardingSignOut)">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                </template>

                <!-- STOPPED: why in a sentence, the setup's own words behind a press, the same press again, Repair to look into it. -->
                <template v-else-if="phase === `setupFailed`">
                    <p class="max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.app.pcSetupFailed`) }}</p>
                    <p v-if="failedReason && detailsOpen" class="rounded-md bg-canvas px-2.5 py-2 font-mono break-words text-2xs text-muted">{{ failedReason }}</p>
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button size="small" :label="t(`ui.action.tryAgain`)" @click="startSetup(false)">
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <button v-if="host.repair" type="button" :class="ui.textButton({ tone: `quiet` })" @click="askRepair">
                            <Icon name="wrench" class="shrink-0" />
                            <span>{{ t(`desktop.pcSetup.repair`) }}</span>
                        </button>
                        <button v-if="failedReason" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="detailsOpen = !detailsOpen">
                            {{ detailsOpen ? t(`desktop.pcSetup.details.hide`) : t(`desktop.pcSetup.details.show`) }}
                        </button>
                    </div>
                </template>

                <!-- The download started at first launch, while there is a setup for it to be ahead of. -->
                <PcPrefetch :prefetch="onboarding?.prefetch.value" @pause="pausePrefetch" @retry="retryPrefetch" />
            </PcStep>

            <!-- 2. THE SIGN-IN, which this PC's setup does not wait for: agents run under an account, and once there is one and
                 the PC is ready, this computer's sandbox is made by itself. -->
            <PcStep :n="2" :state="steps.account" :title="t(`desktop.pcSetup.signIn.title`)">
                <template #line>{{ signInLine }}</template>
                <template v-if="signedOut" #aside>
                    <Button
                        size="small"
                        :tier="steps.account === `current` ? undefined : `boring`"
                        :label="t(`desktop.machineSandbox.signIn`)"
                        :disabled="busy !== undefined"
                        @click="signInNow"
                    >
                        <template #icon><Icon name="sign-in" /></template>
                    </Button>
                </template>
            </PcStep>

            <!-- 3. THE FIRST TASK: closed until someone is signed in, unless one was begun, kept or failed already. -->
            <PcStep :n="3" :state="steps.task" :title="t(`desktop.pcSetup.task.title`)" last>
                <template v-if="taskLine" #line>{{ taskLine }}</template>
                <template v-if="steps.task === `todo`" #aside>
                    <Button size="small" tier="boring" :label="t(`desktop.pcSetup.task.write`)" @click="composing = true">
                        <template #icon><Icon name="pencil" /></template>
                    </Button>
                </template>
                <FirstTaskComposer
                    v-if="taskOpen"
                    v-model:folder="folder"
                    v-model:text="text"
                    :task="drafted ? undefined : firstTask"
                    :starts="starts"
                    :busy="busy !== undefined"
                    @pick="pickFolder"
                    @queue="queueTask"
                    @edit="editTask"
                    @retry="retryTask"
                />
            </PcStep>
        </ol>

        <Notice v-if="failure" tone="danger" class="text-2xs">{{ failure }}</Notice>
    </section>
</template>
