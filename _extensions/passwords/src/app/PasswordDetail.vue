<!-- One password: who it signs in as, the value behind the person's yes, where it works, which agents may use it, what it was used for, and its earlier values. -->
<script setup lang="ts">
import { Button, ConfirmDialog, CopyButton, Icon, messageOr, Notice, SegmentedControl, ui } from "@intentic/extension-ui";
import { timeAgo } from "@intentic/extension-ui/format";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { t } from "../i18n.js";
import ItemTile from "./ItemTile.vue";
import type { AccessLevel, ActivityLine, PasswordItem, PasswordsPort, PasswordVersion, SandboxRef } from "./port.js";
import { accessHelp, activitySentence, originLabel, savedLine } from "./words.js";

const { item, port, sandboxes, now } = defineProps<{
    item: PasswordItem;
    port: PasswordsPort;
    /** The sandboxes linked to this computer, offered access whether or not they have it yet. */
    sandboxes: readonly SandboxRef[];
    now: number;
    /** Narrow layout: the detail stands alone, with a way back to the list. */
    alone?: boolean;
}>();
const emit = defineEmits<{ edit: []; back: []; changed: [] }>();

const manage = computed(() => port.capabilities.manage);
const error = ref<string | undefined>(undefined);
// The one prompt up on the computer, by what it is for: Show, Copy, an access change, a restore, the delete.
const waiting = ref<string | undefined>(undefined);

const act = async (what: string, task: () => Promise<void>): Promise<void> => {
    if (waiting.value !== undefined) {
        return;
    }
    waiting.value = what;
    error.value = undefined;
    try {
        await task();
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
    } finally {
        waiting.value = undefined;
    }
};

/* SHOW AND COPY. The value is the keyring's to hand over, after the person's yes at the computer; shown, it hides
   itself after 20 s, and a copy is cleared from the clipboard by the keyring itself at `clearsAt`. */
const REVEAL_MS = 20_000;
const revealed = ref<string | undefined>(undefined);
const copiedUntil = ref<number | undefined>(undefined);
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const hide = (): void => {
    clearTimeout(hideTimer);
    revealed.value = undefined;
};
const show = (): Promise<void> =>
    act(`reveal`, async () => {
        const answer = await port.reveal(item.name);
        revealed.value = answer.value;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, REVEAL_MS);
    });
const copy = (): Promise<void> =>
    act(`copy`, async () => {
        copiedUntil.value = (await port.copy(item.name, `password`)).clearsAt;
    });
const copySeconds = computed(() => (copiedUntil.value === undefined ? 0 : Math.max(0, Math.ceil((copiedUntil.value - now) / 1000))));

/* AGENTS. Every linked sandbox, and any that has access though it is no longer linked, each with its level. */
const levels = computed(() => {
    const rows = new Map<string, { sandbox: SandboxRef; level: AccessLevel }>();
    for (const sandbox of sandboxes) {
        rows.set(sandbox.url, { sandbox, level: `off` });
    }
    for (const access of item.access) {
        rows.set(access.sandbox.url, { sandbox: access.sandbox, level: access.level });
    }
    return [...rows.values()];
});
const ACCESS_LEVELS: readonly AccessLevel[] = [`ask`, `while-here`, `always`, `off`];
const accessOptions = computed(() => ACCESS_LEVELS.map((level) => ({ label: t(`app.access.${level}`), value: level })));
const setAccess = (sandbox: string, level: AccessLevel): Promise<void> =>
    act(`access:${sandbox}`, async () => {
        await port.setAccess(item.name, sandbox, level);
        emit(`changed`);
    });

/* ACTIVITY AND HISTORY, read for the password on screen; an answer for one the reader has left is dropped. */
const ACTIVITY_SHOWN = 8;
const activity = ref<readonly ActivityLine[]>([]);
const allActivity = ref(false);
const versions = ref<readonly PasswordVersion[]>([]);
const readAround = async (name: string): Promise<void> => {
    activity.value = [];
    versions.value = [];
    allActivity.value = false;
    const [lines, history] = await Promise.all([
        // allow(silent-catch): the record of use is context; a password still shows when it cannot be read
        port.activity(name).catch(() => []),
        // allow(silent-catch): likewise its earlier values, whose section is then not drawn
        manage.value && item.versions > 0 ? port.history(name).catch(() => []) : Promise.resolve([]),
    ]);
    if (name === item.name) {
        activity.value = [...lines].sort((a, b) => b.at - a.at);
        versions.value = [...history].sort((a, b) => b.at - a.at);
    }
};
const shownActivity = computed(() => (allActivity.value ? activity.value : activity.value.slice(0, ACTIVITY_SHOWN)));
const restore = (version: number): Promise<void> =>
    act(`restore:${String(version)}`, async () => {
        await port.restore(item.name, version);
        emit(`changed`);
        await readAround(item.name);
    });

watch(
    () => item.name,
    (name) => {
        hide();
        copiedUntil.value = undefined;
        error.value = undefined;
        void readAround(name);
        // Looked at: it leaves "Just saved".
        if (item.fresh) {
            void port.seen([name]).then(() => emit(`changed`), () => undefined);
        }
    },
    { immediate: true },
);
onBeforeUnmount(() => clearTimeout(hideTimer));

const confirmDelete = ref(false);
const remove = (): Promise<void> =>
    act(`remove`, async () => {
        await port.remove(item.name);
        confirmDelete.value = false;
        emit(`changed`);
    });

const healthLine = computed(() => {
    const health = item.health;
    if (health === undefined || (!health.weak && !health.reused)) {
        return undefined;
    }
    return health.weak && health.reused ? t(`app.detail.weakReused`) : health.weak ? t(`app.detail.weak`) : t(`app.detail.reused`);
});
// What an agent writes to use it, the one name it is known by outside this app.
const reference = computed(() => `{{secret:${item.name}}}`);
const fieldLabel = computed(() => (item.kind === `text` ? t(`app.detail.text`) : t(`app.detail.password`)));
</script>

<template>
    <article class="ui-softscroll flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-8 pr-1" :aria-label="item.title">
        <header class="flex items-start gap-3">
            <button v-if="alone" type="button" :class="ui.iconButton({ size: `lg` }, `-ml-1.5`)" :aria-label="t(`app.back`)" @click="emit(`back`)">
                <Icon name="arrow-left" />
            </button>
            <ItemTile :item="item" size="lg" />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 class="truncate text-lg font-semibold text-content">{{ item.title }}</h2>
                <p class="text-xs text-muted">{{ savedLine(item, now) }}</p>
                <p v-if="item.computer" class="text-xs text-subtle">{{ t(`app.detail.onComputer`, { computer: item.computer }) }}</p>
            </div>
            <Button v-if="manage" tier="boring" size="small" :label="t(`app.editAction`)" @click="emit(`edit`)">
                <template #icon><Icon name="pencil" /></template>
            </Button>
            <Button
                v-else-if="port.manageOnComputer"
                tier="boring"
                size="small"
                :label="t(`app.manageOnComputer`)"
                @click="port.manageOnComputer(item.name)"
            />
        </header>

        <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>

        <!-- The fields: what a person reads, copies and shows. -->
        <section class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
            <div v-if="item.username" class="flex items-center gap-3 px-4 py-3">
                <div class="flex min-w-0 flex-1 flex-col">
                    <span class="text-2xs text-subtle">{{ t(`app.detail.username`) }}</span>
                    <span class="truncate text-sm text-content">{{ item.username }}</span>
                </div>
                <CopyButton :text="item.username" :label="t(`app.detail.copy`)" />
            </div>
            <div v-if="item.backend === undefined || port.capabilities.reveal" class="flex items-center gap-3 px-4 py-3">
                <div class="flex min-w-0 flex-1 flex-col">
                    <span class="text-2xs text-subtle">{{ fieldLabel }}</span>
                    <span v-if="revealed !== undefined" class="break-all font-mono text-sm text-content">{{ revealed }}</span>
                    <span v-else class="text-sm tracking-widest text-content" aria-hidden="true">•••••••••••</span>
                    <span v-if="waiting === `reveal` || waiting === `copy`" class="flex items-center gap-1.5 text-2xs text-info" role="status">
                        <Icon name="spinner" spin />{{ t(`app.confirmHere`) }}
                    </span>
                    <span v-else-if="copySeconds > 0" class="text-2xs text-success" role="status">{{ t(`app.detail.copiedClears`, { seconds: copySeconds }) }}</span>
                </div>
                <template v-if="port.capabilities.reveal">
                    <button
                        type="button"
                        :class="ui.textButton({ tone: `quiet` })"
                        :disabled="waiting !== undefined"
                        :aria-pressed="revealed !== undefined"
                        @click="revealed === undefined ? show() : hide()"
                    >
                        <Icon :name="revealed === undefined ? `eye` : `eye-slash`" />{{ revealed === undefined ? t(`app.detail.show`) : t(`app.detail.hide`) }}
                    </button>
                    <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="waiting !== undefined" @click="copy()">
                        <Icon name="copy" />{{ t(`app.detail.copy`) }}
                    </button>
                </template>
            </div>
            <div class="flex flex-col gap-2 px-4 py-3">
                <span class="text-2xs text-subtle">{{ t(`app.detail.worksOn`) }}</span>
                <div v-if="item.origins.length > 0" class="flex flex-wrap gap-1.5">
                    <span v-for="origin in item.origins" :key="originLabel(origin)" :class="ui.chip()">{{ originLabel(origin) }}</span>
                </div>
                <span v-else class="text-xs text-muted">{{ t(`app.detail.worksNowhere`) }}</span>
                <span v-if="item.unverified" class="text-xs text-subtle">{{ t(`app.detail.unverified`) }}</span>
            </div>
            <div v-if="item.note" class="flex flex-col gap-1 px-4 py-3">
                <span class="text-2xs text-subtle">{{ t(`app.detail.note`) }}</span>
                <p class="whitespace-pre-wrap text-sm text-content">{{ item.note }}</p>
            </div>
        </section>

        <p v-if="healthLine" class="flex items-start gap-2 text-xs text-warning"><Icon name="exclamation-triangle" class="mt-0.5" />{{ healthLine }}</p>
        <p v-if="item.backend" class="text-xs text-muted">{{ t(`app.detail.backend`, { backend: item.backend }) }}</p>
        <p class="text-xs text-subtle">
            {{ t(`app.detail.reference`) }} <code class="font-mono text-content">{{ reference }}</code>
        </p>

        <!-- Agents: one control per sandbox, so a level is changed where it is read. -->
        <section class="flex flex-col gap-3">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.detail.agents`) }}</h3>
            <p v-if="levels.length === 0" class="text-xs text-muted">{{ t(`app.detail.noAgents`) }}</p>
            <div v-for="row in levels" :key="row.sandbox.url" class="flex flex-col gap-1.5">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-2 text-sm text-content"><Icon name="robot" class="text-muted" /><span class="truncate">{{ row.sandbox.label }}</span></span>
                    <SegmentedControl
                        v-if="manage"
                        :model-value="row.level"
                        :options="accessOptions"
                        size="xs"
                        :aria-label="t(`app.access.label`, { sandbox: row.sandbox.label })"
                        @update:model-value="(level: AccessLevel) => setAccess(row.sandbox.url, level)"
                    />
                    <span v-else class="text-xs font-medium text-muted">{{ t(`app.access.${row.level}`) }}</span>
                </div>
                <p v-if="waiting === `access:${row.sandbox.url}`" class="flex items-center gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
                <p v-else class="text-2xs text-subtle">{{ accessHelp(row.level) }}</p>
            </div>
        </section>

        <section class="flex flex-col gap-2">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.detail.activity`) }}</h3>
            <p v-if="activity.length === 0" class="text-xs text-muted">{{ t(`app.detail.noActivity`) }}</p>
            <ol v-else class="flex flex-col gap-1.5">
                <li v-for="line in shownActivity" :key="`${line.at}:${line.op}`" class="flex items-baseline justify-between gap-3 text-xs">
                    <span class="min-w-0 text-content">{{ activitySentence(line) }}</span>
                    <span class="shrink-0 text-subtle">{{ timeAgo(line.at, { now }) }}</span>
                </li>
            </ol>
            <button v-if="!allActivity && activity.length > ACTIVITY_SHOWN" type="button" :class="ui.textButton({ size: `xs` })" @click="allActivity = true">
                {{ t(`app.detail.showAll`) }}
            </button>
        </section>

        <section v-if="manage && versions.length > 0" class="flex flex-col gap-2">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.detail.history`) }}</h3>
            <ol class="flex flex-col gap-1">
                <li v-for="version in versions" :key="version.version" class="flex items-center justify-between gap-3 text-xs">
                    <span class="text-content">{{ t(`app.detail.version`, { when: timeAgo(version.at, { now }) }) }}</span>
                    <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="waiting !== undefined" @click="restore(version.version)">
                        {{ t(`app.detail.restore`) }}
                    </button>
                </li>
            </ol>
        </section>

        <div v-if="manage" class="pt-2">
            <button type="button" :class="ui.textButton({ tone: `danger` })" @click="confirmDelete = true">
                <Icon name="trash" />{{ t(`app.detail.delete`) }}
            </button>
        </div>

        <ConfirmDialog
            :open="confirmDelete"
            :header="t(`app.detail.deleteAsk`, { title: item.title })"
            :description="t(`app.detail.deleteSays`)"
            :confirm-label="t(`app.detail.delete`)"
            :loading="waiting === `remove`"
            @cancel="confirmDelete = false"
            @confirm="remove()"
        />
    </article>
</template>
