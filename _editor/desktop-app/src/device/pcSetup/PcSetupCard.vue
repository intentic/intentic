<script setup lang="ts">
import { Button, formatBytes, type IconName, Notice, ui } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { LOCAL_NAVIGATE_EVENT } from "@intentic/web/local";
import { type LocalCheckRow, localHost, type LocalRestartWhen } from "@intentic/web/local-host";
import { computed, ref, watch } from "vue";
import { firstTaskTakeDraft, signIn } from "../../desktop";
import { draft } from "../../onboarding/firstTask";
import { machineSandbox } from "../machineSandbox";
import FirstTaskComposer from "./FirstTaskComposer.vue";
import PcPrefetch from "./PcPrefetch.vue";
import { pcCard } from "./livePcCard";
import { checksPassed, minutesLeft, offersWork, type PcCardPhase, taskStart, unmetRows } from "./pcCard";

// THIS PC'S OWN SETUP, ON THIS COMPUTER (pcCard.ts says when and why): what a new Windows PC still needs before agents
// run on it, the one "Set up this PC" that does it and how far it is, the restart it asks for, a PC that cannot run
// agents and the machine we host instead; the sign-in, and the first task written meanwhile. Only what is still to do is
// listed: what is already fine is a count in the summary line. Every press goes to the app (onboarding/pc.ts), which
// answers through the state drawn here; what it refuses outright is said at the card's foot.

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

/* THE HEAD: what this is, and where it stands in a word. */

const STATE_WORD = {
    hidden: undefined,
    checking: undefined,
    checkUnknown: `checkUnknown`,
    needsSetup: `needsSetup`,
    settingUp: `settingUp`,
    restart: `restart`,
    admin: `admin`,
    signOut: `signOut`,
    setupFailed: `setupFailed`,
    cantRun: `cantRun`,
    // Said in the line under the head instead ("This PC is ready for agents."), which a word beside it would repeat.
    signIn: undefined,
    firstTaskFailed: undefined,
} as const satisfies Record<PcCardPhase, string | undefined>;
const stateWord = computed(() => {
    const word = STATE_WORD[phase.value];
    return word === undefined ? `` : t(`desktop.pcSetup.state.${word}`);
});

/** The head's glyph: the PC at rest, the setup running, ready, or waiting on the reader. */
interface HeadIcon {
    readonly name: IconName;
    readonly spin: boolean;
    readonly tone: string;
}
const RESTING: HeadIcon = { name: `desktop`, spin: false, tone: `text-subtle` };
const WAITING: HeadIcon = { name: `exclamation-circle`, spin: false, tone: `text-warning` };
const READY: HeadIcon = { name: `check-circle`, spin: false, tone: `text-success` };
const HEAD_ICON = {
    hidden: RESTING,
    checking: RESTING,
    checkUnknown: WAITING,
    needsSetup: RESTING,
    settingUp: { name: `spinner`, spin: true, tone: `text-link` },
    restart: WAITING,
    admin: WAITING,
    signOut: WAITING,
    setupFailed: { name: `exclamation-circle`, spin: false, tone: `text-danger` },
    cantRun: RESTING,
    signIn: READY,
    firstTaskFailed: READY,
} as const satisfies Record<PcCardPhase, HeadIcon>;
const headIcon = computed(() => HEAD_ICON[phase.value]);

// The machine and how much of the check it already passes, in one line, where the check is what the card is about.
const summary = computed(() => {
    if (phase.value !== `needsSetup` && phase.value !== `cantRun`) {
        return ``;
    }
    const passed = checksPassed(check.value);
    const parts = [
        check.value?.machine,
        passed === undefined ? undefined : t(`desktop.pcSetup.passed`, { met: passed.met, total: passed.total }),
    ];
    return parts.filter((part): part is string => part !== undefined && part !== ``).join(` · `);
});

/* THE CHECK: what is still to do, whose it is, and what setting it up costs. */

const todo = computed(() => unmetRows(check.value));
// Why the check could not say, as it said it (onboarding.rs: its one `check` row), for whoever looks into it.
const unknownWhy = computed(() => (phase.value === `checkUnknown` ? todo.value.find((row) => row.detail !== undefined)?.detail : undefined));
const blocked = computed(() => todo.value.filter((row) => row.state === `blocked`));

const rowHint = (row: LocalCheckRow): string => {
    switch (row.state) {
        case `ours`:
            return t(`desktop.requirements.badge.weDoIt`);
        case `yours`:
            return t(`desktop.requirements.badge.youDoIt`);
        case `blocked`:
            return t(`desktop.requirements.badge.unsupported`);
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

const cost = computed(() => {
    const found = check.value;
    if (found === undefined) {
        return ``;
    }
    const parts: string[] = [];
    if (found.minutes > 0) {
        parts.push(t(`desktop.pcSetup.cost.minutes`, { count: found.minutes }));
    }
    if (found.restart) {
        parts.push(t(`desktop.pcSetup.cost.restart`));
    }
    if (found.downloadBytes > 0) {
        parts.push(t(`desktop.pcSetup.cost.download`, { size: formatBytes(found.downloadBytes) }));
    }
    if (found.admin) {
        parts.push(t(`desktop.pcSetup.cost.admin`));
    }
    return parts.join(` · `);
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

/* THE FIRST TASK: written here while the PC is set up, kept by the app until this computer's sandbox can take it. */

const folder = ref(``);
const text = ref(``);
// Shown for a task sent long ago only when "Ask about this" began a new one (`draft`).
const drafted = ref(false);
const taskShown = computed(() => working.value && (firstTask.value?.state !== `sent` || drafted.value));
const starts = computed(() => taskStart(phase.value, signedOut.value));

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
    });
// Taken back to change: the box holds it again, and the app forgets it until it is queued anew.
const editTask = (): Promise<void> =>
    ask(`task`, async () => {
        const kept = firstTask.value;
        if (kept !== undefined) {
            folder.value = kept.folder;
            text.value = kept.text;
        }
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

    <section v-else-if="phase !== `hidden`" class="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm">
        <header class="flex items-start gap-2.5">
            <Icon :name="headIcon.name" :spin="headIcon.spin" class="mt-0.5 shrink-0" :class="headIcon.tone" />
            <div class="min-w-0 flex-1">
                <h2 class="flex flex-wrap items-baseline gap-x-2 text-sm leading-tight font-semibold">
                    <span>{{ t(`desktop.pcSetup.title`) }}</span>
                    <span class="text-2xs font-normal text-subtle">{{ stateWord }}</span>
                </h2>
                <p v-if="summary" class="mt-0.5 truncate text-2xs text-subtle" v-tooltip.top="summary">{{ summary }}</p>
            </div>
        </header>

        <!-- WHAT THIS PC STILL NEEDS, and the one press that does what Intentic can. -->
        <template v-if="phase === `needsSetup`">
            <ul v-if="todo.length > 0" class="flex flex-col gap-1.5 text-xs">
                <li v-for="row in todo" :key="row.id" class="flex items-start gap-2">
                    <Icon :name="ROW_ICON[row.state].name" class="mt-0.5 shrink-0 text-2xs" :class="ROW_ICON[row.state].tone" aria-hidden="true" />
                    <div class="min-w-0 flex-1">
                        <p class="text-content">{{ row.label }}</p>
                        <!-- Only for what the reader has to do: Intentic's own steps need no explaining before they run. -->
                        <p v-if="row.state !== `ours` && row.detail" class="text-2xs text-muted">{{ row.detail }}</p>
                    </div>
                    <span class="shrink-0 text-2xs text-subtle">{{ rowHint(row) }}</span>
                </li>
            </ul>
            <p v-if="cost" class="text-2xs text-muted">{{ cost }}</p>
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

        <!-- The check could not say: asked again, or the setup run anyway, which finds out for itself. -->
        <Notice v-else-if="phase === `checkUnknown`" tone="warning" class="text-xs">
            <span class="block">{{ t(`desktop.pcSetup.unknown`) }}</span>
            <span v-if="unknownWhy" class="mt-0.5 block font-mono break-words text-2xs">{{ unknownWhy }}</span>
            <span class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button size="small" tier="boring" :label="t(`desktop.requirements.checkAgain`)" :loading="busy === `recheck`" @click="recheck" />
                <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="startSetup(false)">{{ t(`desktop.app.setUpThisPc`) }}</button>
            </span>
        </Notice>

        <!-- RUNNING: how far, on what, and how long is left; what Windows is asking for, when it is. -->
        <template v-else-if="phase === `settingUp`">
            <!-- The step it went quiet on is the line under the bar, which is not said twice. -->
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
            <div class="flex flex-col gap-1.5">
                <div
                    class="h-1 overflow-hidden rounded-full bg-line"
                    role="progressbar"
                    :aria-valuenow="percent"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-label="t(`desktop.pcSetup.title`)"
                >
                    <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
                </div>
                <div class="flex items-start gap-3 text-2xs">
                    <!-- Windows' own prompt, in place of the step it holds up: said once, as what to do. -->
                    <span v-if="needsYou" class="flex min-w-0 flex-1 items-start gap-1.5 text-xs font-medium text-warning">
                        <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                        <span>{{ t(`desktop.pcSetup.needsYou`) }}</span>
                    </span>
                    <span v-else class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="step">{{ step }}</span>
                    <span class="shrink-0 tabular-nums text-muted">
                        <template v-if="left !== undefined">{{ t(`desktop.pcSetup.minutesLeft`, { count: left }) }} · </template>{{ t(`desktop.machineSandbox.percent`, { percent }) }}
                    </span>
                </div>
            </div>
        </template>

        <!-- A RESTART FINISHES IT: now, in ten minutes, or the next time Windows starts. -->
        <template v-else-if="phase === `restart`">
            <p class="max-w-read-sm text-xs leading-relaxed text-muted">
                {{ t(`desktop.pcSetup.restart.body`) }} <span class="text-content">{{ t(`desktop.pcSetup.restart.save`) }}</span>
            </p>
            <p v-if="restartAt" class="text-xs font-medium text-content">{{ t(`desktop.pcSetup.restart.at`, { time: restartAt }) }}</p>
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
        <Notice v-else-if="phase === `admin`" tone="warning" class="items-center text-xs">
            <span class="min-w-0 flex-1">{{ t(`desktop.app.pcSetupAdminDeclined`) }}</span>
            <template #actions>
                <Button size="small" tier="boring" :label="t(`desktop.app.setUpThisPc`)" @click="startSetup(false)" />
            </template>
        </Notice>

        <Notice v-else-if="phase === `signOut`" tone="warning" class="text-xs">{{ t(`desktop.pcSetup.signOut`) }}</Notice>

        <!-- STOPPED: why, in the setup's own words, the same press again, and Repair to look into it. -->
        <template v-else-if="phase === `setupFailed`">
            <Notice tone="danger" class="items-start text-xs">
                <span class="block font-medium">{{ t(`desktop.app.pcSetupFailed`) }}</span>
                <span v-if="failedReason" class="mt-0.5 block font-mono break-words text-2xs">{{ failedReason }}</span>
            </Notice>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button size="small" :label="t(`ui.action.tryAgain`)" @click="startSetup(false)">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
                <button v-if="host.repair" type="button" :class="ui.textButton({ tone: `quiet` })" @click="askRepair">
                    <Icon name="wrench" class="shrink-0" />
                    <span>{{ t(`desktop.pcSetup.repair`) }}</span>
                </button>
            </div>
        </template>

        <!-- NO SANDBOX CAN RUN HERE: why, and a computer we host instead. -->
        <template v-else-if="phase === `cantRun`">
            <ul v-if="blocked.length > 0" class="flex flex-col gap-1.5 text-xs">
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
        </template>

        <p v-else-if="phase === `signIn` || phase === `firstTaskFailed`" class="text-xs text-muted">{{ t(`desktop.pcSetup.ready`) }}</p>

        <!-- The download started at first launch, while there is work on this card for it to be ahead of. -->
        <PcPrefetch
            v-if="working"
            :prefetch="onboarding?.prefetch.value"
            @pause="pausePrefetch"
            @retry="retryPrefetch"
        />

        <!-- THE SIGN-IN, which this PC's setup does not wait for: agents run under an account, and once there is one and the
             PC is ready, this computer's sandbox is made by itself. -->
        <div v-if="working && signedOut" class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3 text-xs">
            <Icon name="sign-in" class="shrink-0 text-subtle" aria-hidden="true" />
            <p class="min-w-0 flex-1 text-muted">{{ phase === `signIn` ? t(`desktop.pcSetup.signIn.now`) : t(`desktop.pcSetup.signIn.meanwhile`) }}</p>
            <Button size="small" :tier="phase === `signIn` ? undefined : `boring`" :label="t(`desktop.machineSandbox.signIn`)" :disabled="busy !== undefined" @click="signInNow" />
        </div>

        <FirstTaskComposer
            v-if="taskShown && onboarding"
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

        <Notice v-if="failure" tone="danger" class="text-2xs">{{ failure }}</Notice>
    </section>
</template>
