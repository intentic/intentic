<script setup lang="ts">
import { Button, formatBytes, Notice, ui } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LocalCheckRow, LocalFirstTask, LocalOnboardingHost } from "../../app/environments/localHost";
import { localHost } from "../../app/environments/localHost";
import { useAccount } from "../../client/auth/useAccount";
import AgentsFirstTaskComposer from "./AgentsFirstTaskComposer.vue";

const props = defineProps<{
    onboarding?: LocalOnboardingHost;
    sandboxReady?: boolean;
    /** Design kit: show Ask Repair on setup failed without a real repair host. */
    repairAvailable?: boolean;
}>();

const t = useT();
const router = useRouter();
const route = useRoute();
const host = localHost();
const onboarding = computed(() => props.onboarding ?? host.onboarding);
const { user } = useAccount();

const showDetails = ref(false);
const draftFolder = ref(``);
const draftText = ref(``);
const busy = ref<string | undefined>(undefined);

watch(
    () => onboarding.value?.firstTask.value,
    (task) => {
        if (task !== undefined) {
            draftFolder.value = task.folder;
            draftText.value = task.text;
        }
    },
    { immediate: true },
);

const applyDraftQuery = (): void => {
    if (onboarding.value?.firstTask.value !== undefined) {
        return;
    }
    const folder = route.query[`draftFolder`];
    const text = route.query[`draftText`];
    if (typeof folder === `string` && folder.length > 0) {
        draftFolder.value = folder;
    }
    if (typeof text === `string` && text.length > 0) {
        draftText.value = text;
    }
    if (folder !== undefined || text !== undefined) {
        void router.replace({ path: route.path, query: {} });
    }
};

watch(() => route.query, applyDraftQuery, { immediate: true });

const sandboxReady = computed(() => props.sandboxReady === true || host.project?.machine.value?.state === `ready`);
const signedIn = computed(() => user.value !== null);
const signedInLabel = computed(() => {
    const account = user.value;
    if (account === null) {
        return ``;
    }
    const name = account.name?.trim();
    if (name !== undefined && name.length > 0) {
        return name;
    }
    return account.email;
});

const check = computed(() => onboarding.value?.check.value);
const prefetch = computed(() => onboarding.value?.prefetch.value);
const setup = computed(() => onboarding.value?.setup.value ?? { state: `idle` as const });
const firstTask = computed(() => onboarding.value?.firstTask.value);
const taskSent = computed(() => firstTask.value?.state === `sent`);

const setupStepDone = computed(
    () => sandboxReady.value || check.value?.state === `ready` || setup.value.state === `ready`,
);
const signInStepDone = computed(() => signedIn.value);
const taskStepDone = computed(() => firstTask.value !== undefined);

const phase = computed(() => {
    const ob = onboarding.value;
    if (ob === undefined) {
        return `checking` as const;
    }
    const row = ob.check.value;
    if (row === undefined || row.state === `checking`) {
        return `checking` as const;
    }
    if (row.state === `unknown`) {
        return `checkUnknown` as const;
    }
    if (row.state === `cantRun`) {
        return `cantRun` as const;
    }
    if (sandboxReady.value) {
        return `sandboxReady` as const;
    }
    const run = ob.setup.value;
    if (run.state === `failed`) {
        return `setupFailed` as const;
    }
    if (run.state === `waiting`) {
        if (run.for === `restart`) {
            return `restart` as const;
        }
        if (run.for === `admin`) {
            return `admin` as const;
        }
        return `signOut` as const;
    }
    if (run.state === `running`) {
        return `settingUp` as const;
    }
    if (row.state === `needsSetup`) {
        return `needsSetup` as const;
    }
    return `pcReady` as const;
});

const costLine = computed(() => {
    const row = check.value;
    if (row === undefined) {
        return ``;
    }
    const parts: string[] = [];
    if (row.minutes > 0) {
        parts.push(t(`local.agents.cost.minutes`, { count: row.minutes }));
    }
    if (row.restart) {
        parts.push(t(`local.agents.cost.restart`));
    }
    if (row.downloadBytes > 0) {
        parts.push(t(`local.agents.cost.download`, { size: formatBytes(row.downloadBytes) }));
    }
    return parts.join(t(`local.agents.cost.sep`));
});

const setupSubtitle = computed((): string => {
    if (check.value?.state === `ready`) {
        return t(`local.agents.pcReady.subtitle`);
    }
    return costLine.value;
});

const taskTiming = computed((): `readyPc` | `signedIn` | `notReady` => {
    if (check.value?.state !== `ready`) {
        return `notReady`;
    }
    return signedIn.value ? `signedIn` : `readyPc`;
});

const taskDetailHint = computed((): string | undefined => {
    if (taskTiming.value === `readyPc`) {
        return t(`local.agents.steps.task.detailWhenReady`);
    }
    if (taskTiming.value === `signedIn`) {
        return t(`local.agents.steps.task.detailWhenSignedIn`);
    }
    return undefined;
});

const autoStartHint = computed((): string | undefined => {
    if (taskTiming.value === `readyPc`) {
        return t(`local.agents.task.autoStartSignIn`);
    }
    if (taskTiming.value === `signedIn`) {
        return t(`local.agents.task.autoStartNow`);
    }
    return undefined;
});

const repairShown = computed(() => props.repairAvailable === true || host.repair !== undefined);

const blockedRows = computed(() => check.value?.rows.filter((row) => row.state === `blocked`) ?? []);

const showSetupCard = computed(
    () =>
        phase.value === `needsSetup` ||
        phase.value === `checking` ||
        phase.value === `checkUnknown` ||
        (phase.value === `pcReady` && !sandboxReady.value),
);

const hideSetupStep = computed(() => check.value?.state === `ready`);

const phoneUrl = PLATFORM_WEB_ORIGIN;

const prefetchLine = computed(() => {
    const row = prefetch.value;
    if (row === undefined || row.total <= 0) {
        return ``;
    }
    if (row.done === 0) {
        return t(`local.agents.prefetch.todo`, { total: formatBytes(row.total) });
    }
    return t(`local.agents.prefetch.progress`, { done: formatBytes(row.done), total: formatBytes(row.total) });
});

const prefetchStatus = computed((): string | undefined => {
    const row = prefetch.value;
    if (row === undefined) {
        return undefined;
    }
    if (row.state === `paused`) {
        return t(`local.agents.prefetch.paused`);
    }
    if (row.state === `metered`) {
        return t(`local.agents.prefetch.meteredWait`);
    }
    return undefined;
});

const setupMinutesLeft = computed((): number | undefined => {
    const row = check.value;
    if (setup.value.state !== `running` || row === undefined || row.minutes <= 0) {
        return undefined;
    }
    const left = Math.ceil(row.minutes * (1 - setup.value.percent / 100));
    return left > 0 ? left : undefined;
});

const setupNeedsYou = computed(
    () => setup.value.state === `running` && setup.value.needsYou === true,
);

const restartScheduled = computed(
    () =>
        setup.value.state === `waiting` &&
        setup.value.for === `restart` &&
        setup.value.restartAt !== undefined,
);

const restartAtTime = computed((): string => {
    if (setup.value.state !== `waiting` || setup.value.restartAt === undefined) {
        return ``;
    }
    // Minutes away and the same day: the clock alone, in the reader's language (the kit's formatter).
    return formatClock(setup.value.restartAt * 1000);
});

const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    busy.value = key;
    try {
        await work();
    } finally {
        busy.value = undefined;
    }
};

const rowHint = (row: LocalCheckRow): string => {
    if (row.state === `ours`) {
        return t(`local.agents.check.ours`);
    }
    if (row.state === `yours`) {
        return t(`local.agents.check.yours`);
    }
    if (row.state === `blocked`) {
        return row.detail ?? t(`local.agents.check.blocked`);
    }
    return ``;
};

const rowDone = (row: LocalCheckRow): boolean => row.state === `met`;

const stepCircleClass = (done: boolean): string =>
    done ? `border-success bg-success text-canvas` : `border-line text-muted`;

const retryFirstTask = (): Promise<void> => {
    const task = firstTask.value;
    if (task === undefined || onboarding.value === undefined) {
        return Promise.resolve();
    }
    return onboarding.value.queueFirstTask({ folder: task.folder, text: task.text });
};

const sandboxTaskTitle = (state: LocalFirstTask[`state`]): string => {
    if (state === `sent`) {
        return t(`local.agents.task.status.sentAgent`);
    }
    if (state === `failed`) {
        return t(`local.agents.task.status.failedStart`);
    }
    return t(`local.agents.task.status.${state}`);
};

const goRepair = (): void => {
    const reason = setup.value.state === `failed` ? setup.value.reason : ``;
    void router.push({ path: `/repair`, query: { from: `setup`, reason } });
};
</script>

<template>
    <div class="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
        <header class="space-y-1">
            <h1 class="text-lg font-semibold text-content">{{ t(`local.agents.heading`) }}</h1>
            <p v-if="phase === `checking`" class="text-sm text-muted">{{ t(`local.agents.checking`) }}</p>
        </header>

        <Notice v-if="phase === `checkUnknown`" tone="warning" :title="t(`local.agents.check.unknownTitle`)">
            <p class="text-sm">{{ t(`local.agents.check.unknownBody`) }}</p>
            <div class="mt-3 flex flex-wrap gap-2">
                <Button size="small" :label="t(`local.agents.check.recheck`)" :disabled="busy !== undefined" @click="run(`recheck`, () => onboarding!.recheck())" />
                <Button size="small" tier="boring" :label="t(`local.agents.steps.setup.action`)" :disabled="busy !== undefined" @click="run(`setup`, () => onboarding!.setUp())" />
            </div>
        </Notice>

        <section v-if="phase === `cantRun`" class="space-y-4 rounded-lg border border-line bg-card p-4 shadow-sm">
            <h2 class="text-base font-semibold text-content">{{ t(`local.agents.cantRun.heading`) }}</h2>
            <p v-if="check?.machine" class="text-sm text-content">{{ check.machine }}</p>
            <ul class="space-y-2 text-sm">
                <li v-for="row in blockedRows" :key="row.id">
                    <p class="font-medium text-content">{{ row.label }}</p>
                    <p v-if="row.detail" class="text-muted">{{ row.detail }}</p>
                </li>
            </ul>
            <p class="text-sm text-muted">{{ t(`local.agents.cantRun.hosted`) }}</p>
            <div class="flex flex-wrap gap-2">
                <Button size="small" :label="t(`local.agents.cantRun.cloud`)" :disabled="busy !== undefined" @click="run(`cloud`, () => onboarding!.useCloud())" />
                <Button size="small" tier="boring" :label="t(`local.agents.check.recheck`)" :disabled="busy !== undefined" @click="run(`recheck`, () => onboarding!.recheck())" />
            </div>
        </section>

        <section v-if="showSetupCard" class="rounded-lg border border-line bg-card p-4 shadow-sm">
            <h2 class="text-base font-semibold text-content">{{ t(`local.agents.setup.title`) }}</h2>
            <p v-if="setupSubtitle" class="mt-1 text-sm text-muted">{{ setupSubtitle }}</p>
            <p v-if="check?.machine" class="mt-2 text-sm text-content">{{ check.machine }}</p>
            <ul class="mt-3 space-y-2 text-sm">
                <li v-for="row in check?.rows ?? []" :key="row.id" class="flex flex-wrap items-start gap-2">
                    <span
                        class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border"
                        :class="rowDone(row) ? `bg-success border-success` : ``"
                        aria-hidden="true"
                    ></span>
                    <span class="min-w-0 flex-1">
                        {{ row.label }}
                        <span v-if="rowHint(row)" class="text-muted"> · {{ rowHint(row) }}</span>
                    </span>
                    <button
                        v-if="row.state === `yours`"
                        type="button"
                        :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                        :disabled="busy !== undefined"
                        @click="run(`recheck`, () => onboarding!.recheck())"
                    >
                        {{ t(`local.agents.check.recheck`) }}
                    </button>
                </li>
            </ul>

            <ol class="mt-4 divide-y divide-line border-t border-line text-sm">
                <li v-if="!hideSetupStep" class="flex flex-col items-stretch gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex min-w-0 flex-1 items-start gap-3">
                        <span
                            class="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                            :class="stepCircleClass(setupStepDone)"
                            aria-hidden="true"
                        >
                            <span v-if="setupStepDone">✓</span>
                            <span v-else>1</span>
                        </span>
                        <div class="min-w-0">
                            <p class="font-medium text-content">{{ t(`local.agents.steps.setup.title`) }}</p>
                            <p class="text-muted">{{ t(`local.agents.steps.setup.detail`) }}</p>
                        </div>
                    </div>
                    <Button
                        v-if="!setupStepDone"
                        class="self-start sm:shrink-0"
                        size="small"
                        :label="t(`local.agents.steps.setup.action`)"
                        :disabled="busy !== undefined"
                        @click="run(`setup`, () => onboarding!.setUp())"
                    />
                </li>
                <li class="flex flex-col items-stretch gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex min-w-0 flex-1 items-start gap-3">
                        <span
                            class="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                            :class="stepCircleClass(signInStepDone)"
                            aria-hidden="true"
                        >
                            <span v-if="signInStepDone">✓</span>
                            <span v-else>{{ hideSetupStep ? 1 : 2 }}</span>
                        </span>
                        <div class="min-w-0">
                            <p class="font-medium text-content">{{ t(`local.agents.steps.signIn.title`) }}</p>
                            <p v-if="signInStepDone" class="text-success">{{ t(`local.agents.steps.signIn.done`, { name: signedInLabel }) }}</p>
                            <p v-else class="text-muted">{{ t(`local.agents.steps.signIn.detail`) }}</p>
                        </div>
                    </div>
                    <Button
                        v-if="!signInStepDone"
                        class="self-start sm:shrink-0"
                        size="small"
                        tier="boring"
                        :label="t(`local.agents.steps.signIn.action`)"
                        :disabled="busy !== undefined"
                        @click="run(`signIn`, () => host.signIn())"
                    />
                </li>
                <li class="flex flex-col gap-3 py-3">
                    <div class="flex items-start gap-3">
                        <span
                            class="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                            :class="stepCircleClass(taskStepDone)"
                            aria-hidden="true"
                        >
                            <span v-if="taskStepDone">✓</span>
                            <span v-else>{{ hideSetupStep ? 2 : 3 }}</span>
                        </span>
                        <div>
                            <p class="font-medium text-content">{{ t(`local.agents.steps.task.title`) }}</p>
                            <p class="text-muted">{{ taskDetailHint ?? t(`local.agents.steps.task.detail`) }}</p>
                        </div>
                    </div>
                    <AgentsFirstTaskComposer
                        v-if="onboarding && !taskSent"
                        class="ml-8"
                        :onboarding="onboarding"
                        :first-task="firstTask"
                        :draft-folder="draftFolder"
                        :draft-text="draftText"
                        :busy="busy"
                        :auto-start-hint="autoStartHint"
                        :task-detail-hint="taskDetailHint"
                        @update:draft-folder="draftFolder = $event"
                        @update:draft-text="draftText = $event"
                    />
                </li>
            </ol>

            <div v-if="prefetch && prefetch.state !== `idle` && prefetch.state !== `done`" class="mt-4 space-y-1 text-xs text-muted">
                <div class="flex flex-wrap items-center gap-2">
                    <span>{{ t(`local.agents.prefetch.label`) }}: {{ prefetchLine }}</span>
                    <span v-if="prefetchStatus">{{ prefetchStatus }}</span>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <div class="h-1 min-w-32 flex-1 overflow-hidden rounded-full bg-line">
                        <div
                            class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth"
                            :style="{ width: `${prefetch.total ? (prefetch.done / prefetch.total) * 100 : 0}%` }"
                        ></div>
                    </div>
                    <button
                        v-if="prefetch.state === `running` || prefetch.state === `paused`"
                        type="button"
                        :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                        @click="onboarding?.pause(prefetch.state !== `paused`)"
                    >
                        {{ prefetch.state === `paused` ? t(`local.agents.prefetch.resume`) : t(`local.agents.prefetch.pause`) }}
                    </button>
                    <button
                        v-if="prefetch.state === `metered`"
                        type="button"
                        :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                        @click="onboarding?.pause(false)"
                    >
                        {{ t(`local.agents.prefetch.anyway`) }}
                    </button>
                </div>
            </div>
        </section>

        <section v-if="phase === `settingUp`" class="space-y-4 rounded-lg border border-line bg-card p-4">
            <Notice v-if="setupNeedsYou" tone="warning">
                <p class="text-sm font-medium">{{ t(`local.agents.progress.needsYou`) }}</p>
            </Notice>
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <p class="text-sm font-medium text-content">{{ t(`local.agents.progress.title`) }}</p>
                    <p v-if="setupMinutesLeft !== undefined" class="text-xs text-muted">
                        {{ t(`local.agents.progress.minutesLeft`, { count: setupMinutesLeft }) }}
                    </p>
                </div>
                <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="showDetails = !showDetails">
                    {{ t(`local.agents.progress.details`) }}
                </button>
            </div>
            <div class="h-1 overflow-hidden rounded-full bg-line" role="progressbar" :aria-valuenow="setup.state === `running` ? setup.percent : 0" aria-valuemin="0" aria-valuemax="100">
                <div
                    class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth"
                    :style="{ width: `${setup.state === `running` ? setup.percent : 0}%` }"
                ></div>
            </div>
            <p v-if="setup.state === `running` && setup.step" class="text-sm text-muted">{{ setup.step }}</p>
            <ul v-if="showDetails" class="space-y-1 text-sm">
                <li v-for="row in check?.rows ?? []" :key="row.id" class="flex items-center gap-2 text-muted">
                    <span class="size-2 shrink-0 rounded-full" :class="rowDone(row) ? `bg-success` : `border border-line`"></span>
                    <span>{{ row.label }}</span>
                    <span class="text-xs">{{ rowDone(row) ? t(`local.agents.progress.rowDone`) : t(`local.agents.progress.rowTodo`) }}</span>
                </li>
            </ul>
            <AgentsFirstTaskComposer
                v-if="onboarding && !taskSent"
                :onboarding="onboarding"
                :first-task="firstTask"
                :draft-folder="draftFolder"
                :draft-text="draftText"
                :busy="busy"
                :auto-start-hint="autoStartHint"
                :task-detail-hint="taskDetailHint"
                @update:draft-folder="draftFolder = $event"
                @update:draft-text="draftText = $event"
            />
            <div class="rounded-md border border-line p-3 text-sm">
                <p class="font-medium text-content">{{ t(`local.agents.phone.title`) }}</p>
                <a class="text-xs text-primary underline" :href="phoneUrl" target="_blank" rel="noreferrer">{{ t(`local.agents.phone.link`) }}</a>
            </div>
        </section>

        <section v-if="phase === `restart`" class="space-y-4 rounded-lg border border-line bg-card p-4 shadow-sm">
            <h2 class="text-base font-semibold text-content">{{ t(`local.agents.restart.title`) }}</h2>
            <p class="text-sm text-muted">{{ t(`local.agents.restart.body`) }}</p>
            <p v-if="!restartScheduled" class="text-sm text-content">{{ t(`local.agents.restart.after`) }}</p>
            <p v-else class="text-sm font-medium text-content">{{ t(`local.agents.restart.scheduledAt`, { time: restartAtTime }) }}</p>
            <div v-if="restartScheduled" class="flex flex-wrap gap-2">
                <Button size="small" tier="boring" :label="t(`local.agents.restart.cancel`)" @click="run(`restart`, () => onboarding!.restart(`later`))" />
            </div>
            <div v-else class="flex flex-wrap gap-2">
                <Button size="small" :label="t(`local.agents.restart.now`)" @click="run(`restart`, () => onboarding!.restart(`now`))" />
                <Button size="small" tier="boring" :label="t(`local.agents.restart.ten`)" @click="run(`restart`, () => onboarding!.restart(`in10Minutes`))" />
                <Button size="small" tier="boring" :label="t(`local.agents.restart.later`)" @click="run(`restart`, () => onboarding!.restart(`later`))" />
            </div>
            <p v-if="!restartScheduled" class="text-xs text-muted">{{ t(`local.agents.restart.save`) }}</p>
            <AgentsFirstTaskComposer
                v-if="onboarding && !taskSent"
                :onboarding="onboarding"
                :first-task="firstTask"
                :draft-folder="draftFolder"
                :draft-text="draftText"
                :busy="busy"
                :auto-start-hint="autoStartHint"
                :task-detail-hint="taskDetailHint"
                @update:draft-folder="draftFolder = $event"
                @update:draft-text="draftText = $event"
            />
        </section>

        <Notice v-if="phase === `admin`" tone="warning" :title="t(`local.agents.admin.title`)">
            <p class="text-sm">{{ t(`local.agents.admin.body`) }}</p>
            <Button class="mt-3" size="small" :label="t(`local.agents.admin.retry`)" @click="run(`setup`, () => onboarding!.setUp())" />
        </Notice>
        <AgentsFirstTaskComposer
            v-if="phase === `admin` && onboarding && !taskSent"
            :onboarding="onboarding"
            :first-task="firstTask"
            :draft-folder="draftFolder"
            :draft-text="draftText"
            :busy="busy"
            :auto-start-hint="autoStartHint"
            :task-detail-hint="taskDetailHint"
            @update:draft-folder="draftFolder = $event"
            @update:draft-text="draftText = $event"
        />

        <Notice v-if="phase === `signOut`" tone="warning" :title="t(`local.agents.signOut.title`)">
            <p class="text-sm">{{ t(`local.agents.signOut.body`) }}</p>
        </Notice>
        <AgentsFirstTaskComposer
            v-if="phase === `signOut` && onboarding && !taskSent"
            :onboarding="onboarding"
            :first-task="firstTask"
            :draft-folder="draftFolder"
            :draft-text="draftText"
            :busy="busy"
            :auto-start-hint="autoStartHint"
            :task-detail-hint="taskDetailHint"
            @update:draft-folder="draftFolder = $event"
            @update:draft-text="draftText = $event"
        />

        <Notice v-if="phase === `setupFailed`" tone="danger" :title="t(`local.agents.failed.title`)">
            <p class="text-sm">{{ setup.state === `failed` ? setup.reason : `` }}</p>
            <div class="mt-3 flex flex-wrap gap-2">
                <Button size="small" :label="t(`local.agents.failed.retry`)" @click="run(`setup`, () => onboarding!.setUp())" />
                <Button v-if="repairShown" size="small" tier="boring" :label="t(`local.agents.failed.repair`)" @click="goRepair()" />
            </div>
        </Notice>
        <AgentsFirstTaskComposer
            v-if="phase === `setupFailed` && onboarding && !taskSent"
            :onboarding="onboarding"
            :first-task="firstTask"
            :draft-folder="draftFolder"
            :draft-text="draftText"
            :busy="busy"
            :auto-start-hint="autoStartHint"
            :task-detail-hint="taskDetailHint"
            @update:draft-folder="draftFolder = $event"
            @update:draft-text="draftText = $event"
        />

        <section v-if="phase === `sandboxReady`" class="space-y-4 rounded-lg border border-line bg-card p-4">
            <h2 class="text-base font-semibold text-content">{{ t(`local.agents.ready.title`) }}</h2>
            <Button size="small" :label="t(`local.agents.ready.workspace`)" @click="host.openWorkspace()" />
            <div v-if="firstTask" class="rounded-md border border-line bg-canvas p-3 text-sm">
                <p class="font-medium text-content">{{ sandboxTaskTitle(firstTask.state) }}</p>
                <p class="text-muted">{{ firstTask.folder }}</p>
                <p class="mt-1 text-content">{{ firstTask.text }}</p>
                <p v-if="firstTask.state === `failed` && firstTask.reason" class="mt-2 text-xs text-danger">{{ firstTask.reason }}</p>
                <Button v-if="firstTask.state === `sent`" class="mt-2" size="small" tier="boring" :label="t(`local.agents.task.open`)" @click="host.openWorkspace()" />
                <Button
                    v-if="firstTask.state === `failed`"
                    class="mt-2"
                    size="small"
                    :label="t(`local.agents.task.retry`)"
                    @click="run(`task`, retryFirstTask)"
                />
            </div>
        </section>

        <p v-if="onboarding === undefined" class="text-sm text-muted">{{ t(`local.agents.noHost`) }}</p>
    </div>
</template>
