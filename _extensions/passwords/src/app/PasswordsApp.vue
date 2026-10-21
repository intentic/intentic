<!-- THE PASSWORDS APP, as any host mounts it with a PasswordsPort: the first run, then an index, a list and a password, with Requests and Settings in the same frame. -->
<script setup lang="ts">
import { Button, Icon, messageOr, Modal, Notice, SearchBar, SegmentedControl, SplitView, ui, useNarrow, useNow } from "@intentic/extension-ui";
import { formatClock } from "@intentic/extension-ui/format";
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n.js";
import FirstRun from "./FirstRun.vue";
import { filterKey, filterOf, indexCounts, recentlySaved, visibleItems } from "./model.js";
import PasswordDetail from "./PasswordDetail.vue";
import PasswordEditor from "./PasswordEditor.vue";
import PasswordIndex from "./PasswordIndex.vue";
import PasswordList from "./PasswordList.vue";
import type { PasswordsPort, SandboxRef } from "./port.js";
import type { PasswordsSelection } from "./selection.js";
import RequestsView from "./RequestsView.vue";
import SettingsView from "./SettingsView.vue";
import { usePasswordsState } from "./state.js";
import ToastStack from "./ToastStack.vue";

const { port, selection = {} } = defineProps<{ port: PasswordsPort; selection?: PasswordsSelection }>();
const emit = defineEmits<{ "update:selection": [selection: PasswordsSelection] }>();

const state = usePasswordsState(port);
const { status, items, requests, toasts } = state;
const ready = state.ready;
const manage = computed(() => port.capabilities.manage);
const now = useNow(true, 1000);

/* THE SELECTION, held here and told to the host, which may hand it back (a deep link, the back button). */
const SETTINGS = `settings`;
const current = ref(selection.filter ?? `all`);
const selected = ref<string | undefined>(selection.item);
const query = ref(selection.query ?? ``);
watch(
    () => selection,
    (next) => {
        current.value = next.filter ?? `all`;
        selected.value = next.item;
        query.value = next.query ?? ``;
    },
);
const tell = (): void => {
    emit(`update:selection`, {
        filter: current.value === `all` ? undefined : current.value,
        item: selected.value,
        query: query.value === `` ? undefined : query.value,
    });
};
watch(query, tell);

const filter = computed(() => filterOf(current.value));
const onSettings = computed(() => current.value === SETTINGS && manage.value);
const onRequests = computed(() => filter.value.kind === `requests`);
const visible = computed(() => visibleItems(items.value, filter.value, query.value));
const counts = computed(() => indexCounts(items.value, requests.value));
const recent = computed(() => (filter.value.kind === `fresh` || query.value !== `` ? [] : recentlySaved(items.value, now.value)));
const item = computed(() => items.value.find((candidate) => candidate.name === selected.value));

// Every sandbox an agent of which has access to something, named as the access names it, then the linked ones.
const knownSandboxes = computed((): SandboxRef[] => {
    const all = new Map<string, SandboxRef>();
    for (const sandbox of state.sandboxes.value) {
        all.set(sandbox.url, sandbox);
    }
    for (const access of items.value.flatMap((candidate) => candidate.access)) {
        all.set(access.sandbox.url, access.sandbox);
    }
    return [...all.values()];
});

const pick = (key: string): void => {
    current.value = key;
    // A password stays open while it is still in the list the reader moved to.
    if (selected.value !== undefined && !visibleItems(items.value, filterOf(key), query.value).some((candidate) => candidate.name === selected.value)) {
        selected.value = undefined;
    }
    editing.value = false;
    tell();
};
const select = (name: string): void => {
    selected.value = name;
    editing.value = false;
    tell();
};
const view = (name: string): void => {
    current.value = `all`;
    query.value = ``;
    select(name);
};

/* THE TWO COLUMNS OF THE BODY, list and password, side by side with room and one at a time without. */
const body = ref<HTMLElement | undefined>(undefined);
const narrow = useNarrow(body, 40);
const detailOpen = ref(false);
const open = (name: string): void => {
    select(name);
    detailOpen.value = true;
};
const showDetail = computed(() => !narrow.value || detailOpen.value);
const showList = computed(() => !narrow.value || !detailOpen.value || item.value === undefined);

/* KEYS: Ctrl/⌘+K and `/` reach the search while the app has the focus; Esc clears it. */
const search = ref<{ focus: () => void } | undefined>(undefined);
const onKey = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === `k`) {
        event.preventDefault();
        event.stopPropagation();
        search.value?.focus();
    }
};

/* EDIT AND NEW. */
const editing = ref(false);
const creating = ref(false);
const saved = async (name: string): Promise<void> => {
    editing.value = false;
    creating.value = false;
    await state.load();
    view(name);
};

/* THE LOCK. */
const lockChip = computed(() => {
    const vault = ready.value;
    if (vault === undefined) {
        return undefined;
    }
    if (vault.locked) {
        return t(`app.lock.locked`);
    }
    return vault.unlockedUntil === undefined ? t(`app.lock.unlocked`) : t(`app.lock.unlockedUntil`, { time: formatClock(vault.unlockedUntil) });
});
const lockError = ref<string | undefined>(undefined);
const locking = ref(false);
const toggleLock = async (): Promise<void> => {
    locking.value = true;
    lockError.value = undefined;
    try {
        await (ready.value?.locked === true ? port.unlock() : port.lock());
    } catch (failure) {
        lockError.value = failure instanceof Error ? failure.message : t(`app.error.act`);
    } finally {
        locking.value = false;
        await state.load();
    }
};

// The unavailable state's own way out, when the port offers one: the fix, then a fresh read either way.
const fixing = ref(false);
const fixError = ref<string | undefined>(undefined);
const runFix = async (): Promise<void> => {
    if (fixing.value) {
        return;
    }
    fixing.value = true;
    fixError.value = undefined;
    try {
        if (status.value?.kind === `unavailable`) {
            await status.value.fix?.run();
        }
    } catch (failure) {
        fixError.value = messageOr(failure, t(`app.error.act`));
    } finally {
        await state.load();
        fixing.value = false;
    }
};

/* FIRST RUN: shown while the vault is not set up, and kept through its later steps after it is. */
const firstRun = ref(false);
watch(
    status,
    (next) => {
        if (next?.kind === `not-set-up` && manage.value) {
            firstRun.value = true;
        }
    },
    { immediate: true },
);
const finishFirstRun = async (): Promise<void> => {
    firstRun.value = false;
    await state.load();
};

// The one-time question, for a vault set up before it was asked, or set up elsewhere.
const askRemember = computed(() => manage.value && ready.value !== undefined && !ready.value.rememberAsked && !firstRun.value);
const rememberAll = async (): Promise<void> => {
    try {
        const sources = await port.sources();
        await port.updateSettings({ remember: Object.fromEntries(sources.filter((source) => source.available).map((source) => [source.source, true])) });
        for (const source of sources.filter((candidate) => candidate.available && !candidate.ready)) {
            await port.setUpSource(source.source);
        }
    } catch (failure) {
        lockError.value = failure instanceof Error ? failure.message : t(`app.error.act`);
    } finally {
        await state.load();
    }
};

// The compact index a narrow window shows above the body, in place of the rail.
const compactOptions = computed(() => [
    { label: t(`app.index.all`), value: `all` },
    { label: t(`app.index.site`), value: `site` },
    { label: t(`app.index.app`), value: `app` },
    { label: t(`app.index.terminal`), value: `terminal` },
    { label: t(`app.index.fresh`), value: `fresh`, badge: counts.value.fresh },
    { label: t(`app.index.requests`), value: `requests`, badge: counts.value.requests },
]);

const emptyText = computed(() => {
    if (query.value !== ``) {
        return t(`app.list.emptySearch`, { query: query.value });
    }
    return items.value.length === 0 ? t(`app.list.emptyAll`) : t(`app.list.empty`);
});

// A password opened from outside (a deep link, a toast's View) is scrolled to once the list has it.
watch(item, async (found) => {
    if (found !== undefined && narrow.value) {
        await nextTick();
        detailOpen.value = true;
    }
});
</script>

<template>
    <div class="relative flex h-full min-h-0 flex-col" @keydown="onKey">
        <p v-if="status === undefined && state.readError.value === undefined" class="m-auto text-sm text-muted" role="status">{{ t(`app.loading`) }}</p>

        <div v-else-if="status === undefined || status.kind === `unavailable`" class="m-auto flex max-w-md flex-col items-center gap-3 px-6 text-center">
            <Icon name="key" class="text-4xl text-subtle" />
            <p class="text-base font-semibold text-content">{{ t(`app.unavailable.title`) }}</p>
            <p class="text-sm text-muted">{{ status?.kind === `unavailable` ? status.reason : state.readError.value }}</p>
            <p v-if="fixError" class="text-sm text-danger" role="alert">{{ fixError }}</p>
            <Button
                v-if="status?.kind === `unavailable` && status.fix"
                :label="status.fix.label"
                :disabled="fixing"
                @click="runFix()"
            />
            <Button v-else tier="boring" :label="t(`app.retry`)" @click="state.load()" />
        </div>

        <FirstRun
            v-else-if="manage && (firstRun || status.kind === `not-set-up`)"
            :port="port"
            :status="status.kind === `not-set-up` ? status : undefined"
            @done="finishFirstRun()"
        />

        <SplitView v-else :title="t(`app.title`)" width="full">
            <template #actions>
                <div class="flex flex-wrap items-center gap-2">
                    <SearchBar
                        ref="search"
                        v-model="query"
                        variant="field"
                        clearable
                        shortcut="/"
                        class="w-64 max-w-full"
                        :placeholder="t(`app.search`)"
                        :aria-label="t(`app.search`)"
                    />
                    <span
                        v-if="lockChip"
                        class="flex items-center gap-1.5 rounded-full border border-line-subtle px-2.5 py-1 text-2xs"
                        :class="ready?.locked ? `text-muted` : `text-success`"
                    >
                        <Icon :name="ready?.locked ? `lock` : `unlock`" />{{ lockChip }}
                    </span>
                    <button
                        v-if="ready && manage"
                        type="button"
                        :class="ui.textButton({ tone: `quiet` })"
                        :disabled="locking"
                        @click="toggleLock()"
                    >
                        <Icon v-if="locking" name="spinner" spin />{{ ready.locked ? t(`app.lock.unlock`) : t(`app.lock.lockNow`) }}
                    </button>
                    <template v-if="manage">
                        <button type="button" :class="ui.iconButton({ size: `lg` })" :aria-label="t(`app.new`)" :title="t(`app.new`)" @click="creating = true">
                            <Icon name="plus" />
                        </button>
                        <button
                            type="button"
                            :class="ui.iconButton({ size: `lg`, on: onSettings })"
                            :aria-label="t(`app.settingsAction`)"
                            :aria-pressed="onSettings"
                            :title="t(`app.settingsAction`)"
                            @click="pick(onSettings ? `all` : SETTINGS)"
                        >
                            <Icon name="cog" />
                        </button>
                    </template>
                    <Button v-else-if="port.manageOnComputer" tier="boring" size="small" :label="t(`app.manageOnComputer`)" @click="port.manageOnComputer()" />
                </div>
            </template>

            <template #strips>
                <Notice v-if="lockError" tone="danger" size="sm" @dismiss="lockError = undefined">{{ lockError }}</Notice>
                <Notice v-if="state.readError.value" tone="danger" size="sm">{{ state.readError.value }}</Notice>
                <Notice v-if="askRemember" tone="info" size="sm">
                    {{ t(`app.remember.strip`) }}
                    <template #actions><Button size="small" :label="t(`app.remember.turnOn`)" @click="rememberAll()" /></template>
                </Notice>
                <p v-if="ready?.locked" class="text-xs text-muted">{{ t(`app.lock.lockedNote`) }}</p>
            </template>

            <template #compact>
                <SegmentedControl :model-value="current" :options="compactOptions" wrap :aria-label="t(`app.index.label`)" @update:model-value="pick" />
            </template>

            <template #rail>
                <PasswordIndex :counts="counts" :sandboxes="knownSandboxes" :current="current" @pick="pick" />
            </template>

            <template #detail>
                <SettingsView
                    v-if="onSettings && ready"
                    :port="port"
                    :unlock="ready.unlock"
                    @changed="state.load()"
                    @close="pick(`all`)"
                />
                <RequestsView v-else-if="onRequests" :requests="requests" :items="items" :port="port" :now="now" @answered="state.load()" />
                <div v-else ref="body" class="relative flex min-h-0 flex-1 gap-6">
                    <div v-if="showList" class="flex min-h-0 flex-col" :class="narrow ? `flex-1` : `w-80 shrink-0`">
                        <PasswordList :items="visible" :selected="selected" :recent="recent" :empty="emptyText" @select="select" @open="open" @review="pick(`fresh`)" />
                    </div>
                    <div v-if="showDetail && (!narrow || item)" class="flex min-h-0 min-w-0 flex-1 flex-col">
                        <template v-if="item">
                            <div v-if="editing" class="ui-softscroll flex min-h-0 flex-1 flex-col overflow-y-auto pb-8 pr-1">
                                <PasswordEditor :key="item.name" :item="item" :port="port" @saved="saved" @cancel="editing = false" />
                            </div>
                            <PasswordDetail
                                v-else
                                :item="item"
                                :port="port"
                                :sandboxes="knownSandboxes"
                                :now="now"
                                :alone="narrow"
                                @edit="editing = true"
                                @back="detailOpen = false"
                                @changed="state.load()"
                            />
                        </template>
                        <p v-else class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-subtle">{{ t(`app.list.nothingSelected`) }}</p>
                    </div>
                </div>
            </template>
        </SplitView>

        <Modal v-model:open="creating" size="md" :header="t(`app.edit.newTitle`)" :description="t(`app.edit.newDescription`)">
            <PasswordEditor v-if="creating" :port="port" @saved="saved" @cancel="creating = false" />
        </Modal>

        <ToastStack :toasts="toasts" :port="port" @dismiss="state.dismissToast" @view="view" @undone="state.load()" />
    </div>
</template>
