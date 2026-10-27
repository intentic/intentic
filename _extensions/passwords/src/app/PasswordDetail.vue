<!-- One password: who it signs in as, the value behind the person's yes, where it works, which agents may use it, what it was used for, and its earlier values.
     Every one of them is changed where it is read, one at a time, through the person's yes at the computer: there is no edit form. -->
<script setup lang="ts">
import {
    Button,
    ConfirmDialog,
    CopyButton,
    Icon,
    InlineRename,
    messageOr,
    Notice,
    ProseField,
    Section,
    SegmentedControl,
    ToggleSwitch,
    ui,
} from "@intentic/extension-ui";
import { timeAgo } from "@intentic/extension-ui/format";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { t } from "../i18n.js";
import ItemTile from "./ItemTile.vue";
import PasswordPlaces from "./PasswordPlaces.vue";
import PasswordValuePopover from "./PasswordValuePopover.vue";
import type { AccessLevel, ActivityLine, PasswordItem, PasswordPatch, PasswordsPort, PasswordVersion, SandboxRef } from "./port.js";
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
const emit = defineEmits<{ back: []; changed: [] }>();

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

/* EACH FIELD CHANGED WHERE IT IS READ: one patch per change, through the keyring and the person's yes at the computer, as
   the whole form's Save once was. Text fields write when they are left or Enter is pressed, never mid-word; Esc puts back
   what is stored. */
const uid = useId();
const edit = (what: string, patch: PasswordPatch): Promise<void> =>
    act(what, async () => {
        await port.edit(item.name, patch);
        emit(`changed`);
    });
// The title is a name, renamed in place (InlineRename); a refusal stays in its own field, so it throws rather than act()s.
const rename = async (title: string): Promise<void> => {
    waiting.value = `title`;
    try {
        await port.edit(item.name, { title });
        emit(`changed`);
    } finally {
        waiting.value = undefined;
    }
};
// A field's text on screen: seeded from the password, following a change made elsewhere only while it holds nothing of the
// reader's own, and reset when another password is opened.
const usernameDraft = ref(item.username ?? ``);
const noteDraft = ref(item.note ?? ``);
watch(
    () => item.username ?? ``,
    (next, before) => {
        if (usernameDraft.value === before) {
            usernameDraft.value = next;
        }
    },
);
watch(
    () => item.note ?? ``,
    (next, before) => {
        if (noteDraft.value === before) {
            noteDraft.value = next;
        }
    },
);
const writeUsername = (): void => {
    const next = usernameDraft.value.trim();
    if (next !== (item.username ?? ``)) {
        void edit(`username`, { username: next });
    }
};
const writeNote = (): void => {
    const next = noteDraft.value.trim();
    if (next !== (item.note ?? ``)) {
        void edit(`note`, { note: next });
    }
};
const blurOut = (event: Event): void => {
    if (event.target instanceof HTMLElement) {
        event.target.blur();
    }
};
const revertUsername = (event: Event): void => {
    usernameDraft.value = item.username ?? ``;
    blurOut(event);
};
const revertNote = (event: Event): void => {
    noteDraft.value = item.note ?? ``;
    blurOut(event);
};
const setPlaces = (origins: KeyringOrigin[]): Promise<void> => edit(`origins`, { origins });
const setAnyField = (anyField: boolean): Promise<void> => edit(`anyField`, { anyField });
// A new value is set where the dots are read, in its own small panel (PasswordValuePopover.vue).
const valueAnchor = ref<HTMLElement>();
const changingValue = ref(false);
const setValue = async (patch: PasswordPatch): Promise<void> => {
    await edit(`value`, patch);
    if (error.value === undefined) {
        changingValue.value = false;
    }
};

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
        usernameDraft.value = item.username ?? ``;
        noteDraft.value = item.note ?? ``;
        changingValue.value = false;
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
                <h2 class="min-w-0 text-lg font-semibold text-content">
                    <InlineRename
                        :value="item.title"
                        :write="rename"
                        :label="t(`app.edit.title`)"
                        :action="t(`app.edit.title`)"
                        :editable="manage"
                        :maxlength="200"
                        :failure="t(`app.error.act`)"
                    />
                </h2>
                <p class="text-xs text-muted">{{ savedLine(item, now) }}</p>
                <p v-if="item.computer" class="text-xs text-subtle">{{ t(`app.detail.onComputer`, { computer: item.computer }) }}</p>
            </div>
            <Button
                v-if="!manage && port.manageOnComputer"
                tier="boring"
                size="small"
                :label="t(`app.manageOnComputer`)"
                @click="port.manageOnComputer(item.name)"
            />
        </header>

        <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>

        <!-- The fields: what a person reads, copies and shows. -->
        <section class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
            <div v-if="item.username || manage" class="flex items-center gap-3 px-4 py-3">
                <div class="flex min-w-0 flex-1 flex-col">
                    <label :for="`${uid}-username`" class="text-2xs text-subtle">{{ t(`app.detail.username`) }}</label>
                    <!-- The field reads as the text it holds (the kit's frameless field, which lights its ground once it has a
                         caret), with a wash under a pointer to say it can be written in. -->
                    <input
                        v-if="manage"
                        :id="`${uid}-username`"
                        v-model="usernameDraft"
                        class="field-bare ui-field-lit -mx-1 w-full min-w-0 rounded-md px-1 transition-colors hover:bg-content/5"
                        maxlength="256"
                        autocomplete="off"
                        spellcheck="false"
                        :placeholder="t(`app.detail.noUsername`)"
                        @blur="writeUsername"
                        @keydown.enter.prevent="blurOut"
                        @keydown.esc.prevent="revertUsername"
                    />
                    <span v-else :id="`${uid}-username`" class="truncate text-sm text-content">{{ item.username }}</span>
                    <p v-if="waiting === `username`" class="flex items-center gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
                </div>
                <CopyButton v-if="item.username" :text="item.username" :label="t(`app.detail.copy`)" />
            </div>
            <div v-if="item.backend === undefined || port.capabilities.reveal || manage" class="flex items-center gap-3 px-4 py-3">
                <div class="flex min-w-0 flex-1 flex-col">
                    <span class="text-2xs text-subtle">{{ fieldLabel }}</span>
                    <!-- The value itself is where a new one is set: pressing it opens the panel for it, anchored here. -->
                    <button
                        v-if="manage"
                        ref="valueAnchor"
                        type="button"
                        class="-mx-1 cursor-pointer self-start rounded-md px-1 text-left text-sm text-content transition-colors hover:bg-content/5"
                        :class="revealed !== undefined ? `break-all font-mono` : `tracking-widest`"
                        :aria-label="item.kind === `text` ? t(`app.detail.newText`) : t(`app.detail.newPassword`)"
                        v-tooltip.top="item.kind === `text` ? t(`app.detail.newText`) : t(`app.detail.newPassword`)"
                        @click="changingValue = true"
                    >
                        {{ revealed ?? `•••••••••••` }}
                    </button>
                    <span v-else-if="revealed !== undefined" class="break-all font-mono text-sm text-content">{{ revealed }}</span>
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
                <PasswordPlaces :origins="item.origins" :editable="manage" :busy="waiting === `origins`" @change="setPlaces" />
                <span v-if="item.unverified" class="text-xs text-subtle">{{ t(`app.detail.unverified`) }}</span>
                <p v-if="waiting === `origins`" class="flex items-center gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
            </div>
            <div v-if="item.note || manage" class="flex flex-col gap-1 px-4 py-3">
                <label :for="`${uid}-note`" class="text-2xs text-subtle">{{ t(`app.detail.note`) }}</label>
                <ProseField
                    v-if="manage"
                    :id="`${uid}-note`"
                    v-model="noteDraft"
                    class="-mx-2 rounded-md transition-colors hover:bg-content/5"
                    maxlength="500"
                    :placeholder="t(`app.detail.addNote`)"
                    @blur="writeNote"
                    @keydown.esc.prevent="revertNote"
                />
                <p v-else :id="`${uid}-note`" class="whitespace-pre-wrap text-sm text-content">{{ item.note }}</p>
                <p v-if="waiting === `note`" class="flex items-center gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
            </div>
            <label v-if="manage" class="flex items-start gap-3 px-4 py-3">
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="text-sm text-content">{{ t(`app.edit.anyField`) }}</span>
                    <span class="text-2xs text-subtle">{{ t(`app.edit.anyFieldHelp`) }}</span>
                </span>
                <ToggleSwitch
                    :model-value="item.anyField"
                    :disabled="waiting !== undefined"
                    :aria-label="t(`app.edit.anyField`)"
                    @update:model-value="setAnyField"
                />
            </label>
        </section>

        <p v-if="healthLine" class="flex items-start gap-2 text-xs text-warning"><Icon name="exclamation-triangle" />{{ healthLine }}</p>
        <p v-if="item.backend" class="text-xs text-muted">{{ t(`app.detail.backend`, { backend: item.backend }) }}</p>
        <p class="text-xs text-subtle">
            {{ t(`app.detail.reference`) }} <code class="font-mono text-content">{{ reference }}</code>
        </p>

        <!-- Agents: one control per sandbox, so a level is changed where it is read. -->
        <Section :label="t(`app.detail.agents`)" :heading="3">
            <div class="flex flex-col gap-3">
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
            </div>
        </Section>

        <Section :label="t(`app.detail.activity`)" :heading="3">
            <div class="flex flex-col gap-2">
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
            </div>
        </Section>

        <Section v-if="manage && versions.length > 0" :label="t(`app.detail.history`)" :heading="3">
            <ol class="flex flex-col gap-1">
                <li v-for="version in versions" :key="version.version" class="flex items-center justify-between gap-3 text-xs">
                    <span class="text-content">{{ t(`app.detail.version`, { when: timeAgo(version.at, { now }) }) }}</span>
                    <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="waiting !== undefined" @click="restore(version.version)">
                        {{ t(`app.detail.restore`) }}
                    </button>
                </li>
            </ol>
        </Section>

        <div v-if="manage" class="pt-2">
            <button type="button" :class="ui.textButton({ tone: `danger` })" @click="confirmDelete = true">
                <Icon name="trash" />{{ t(`app.detail.delete`) }}
            </button>
        </div>

        <PasswordValuePopover v-if="manage" v-model="changingValue" :item="item" :anchor="valueAnchor" :saving="waiting === `value`" @save="setValue" />

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
