<!-- Passwords' settings on this computer: where passwords are remembered from, how it unlocks and locks, the recovery key, places never saved for, and import. -->
<script setup lang="ts">
import { Button, Icon, messageOr, Notice, ToggleSwitch, ui } from "@intentic/extension-ui";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { originKey } from "@intentic/sandbox-contract/policy/keyring-origins";
import { computed, onMounted, ref, shallowRef } from "vue";
import { t } from "../i18n.js";
import ImportPanel from "./ImportPanel.vue";
import type { PasswordsPort, PasswordsSettings, PasswordsSettingsPatch, RememberSource, SourceStatus, UnlockWay } from "./port.js";
import { originLabel } from "./words.js";

const { port, unlock } = defineProps<{ port: PasswordsPort; unlock: readonly UnlockWay[] }>();
const emit = defineEmits<{ changed: []; close: [] }>();

const settings = shallowRef<PasswordsSettings | undefined>(undefined);
const sources = shallowRef<readonly SourceStatus[]>([]);
const error = ref<string | undefined>(undefined);
const waiting = ref<string | undefined>(undefined);

const read = async (): Promise<void> => {
    try {
        [settings.value, sources.value] = await Promise.all([port.settings(), port.sources()]);
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.read`));
    }
};
onMounted(read);

const act = async (what: string, task: () => Promise<void>): Promise<void> => {
    waiting.value = what;
    error.value = undefined;
    try {
        await task();
        emit(`changed`);
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
    } finally {
        waiting.value = undefined;
    }
};

const update = (what: string, patch: PasswordsSettingsPatch): Promise<void> =>
    act(what, async () => {
        settings.value = await port.updateSettings(patch);
    });

// A switch turned on for a source not yet in place sets it up first: the browser's permission, askpass.
const toggleSource = (source: SourceStatus, on: boolean): Promise<void> =>
    act(`source:${source.source}`, async () => {
        if (on && !source.ready) {
            await port.setUpSource(source.source);
        }
        settings.value = await port.updateSettings({ remember: { [source.source]: on } });
        sources.value = await port.sources();
    });
const setUp = (source: RememberSource): Promise<void> =>
    act(`source:${source}`, async () => {
        await port.setUpSource(source);
        sources.value = await port.sources();
    });

const sourceState = (source: SourceStatus): string => {
    if (!source.available) {
        return source.why ?? t(`app.settings.unavailable`);
    }
    if (!source.ready) {
        return source.asks ?? t(`app.settings.setUp`);
    }
    return source.on ? t(`app.settings.on`) : t(`app.settings.off`);
};

const LOCK_MINUTES = [5, 15, 30, 60, 240, 720] as const;
const lockOptions = computed(() =>
    LOCK_MINUTES.map((minutes) => ({
        value: minutes,
        label: minutes < 60 ? t(`app.settings.minutes`, { count: minutes }, minutes) : t(`app.settings.hours`, { count: minutes / 60 }, minutes / 60),
    })),
);
const onLockMinutes = (event: Event): void => {
    if (event.target instanceof HTMLSelectElement) {
        void update(`autoLock`, { autoLockMinutes: Number(event.target.value) });
    }
};

const unlockNote = computed(() =>
    unlock.includes(`hello`) ? t(`app.settings.hello`) : unlock.includes(`polkit`) ? t(`app.settings.polkit`) : t(`app.settings.passphrase`),
);

const forget = (origin: KeyringOrigin): Promise<void> =>
    update(`never:${originKey(origin)}`, { neverSave: (settings.value?.neverSave ?? []).filter((known) => originKey(known) !== originKey(origin)) });
</script>

<template>
    <section class="ui-softscroll flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto pb-10 pr-1" :aria-label="t(`app.settings.title`)">
        <header class="flex items-center gap-2">
            <button type="button" :class="ui.iconButton({ size: `lg` }, `-ml-1.5`)" :aria-label="t(`app.back`)" @click="emit(`close`)">
                <Icon name="arrow-left" />
            </button>
            <h2 class="text-lg font-semibold text-content">{{ t(`app.settings.title`) }}</h2>
        </header>

        <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>

        <section class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
                <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.settings.remember`) }}</h3>
                <p class="text-xs text-muted">{{ t(`app.settings.rememberHelp`) }}</p>
            </div>
            <div class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
                <div v-for="source in sources" :key="source.source" class="flex items-center gap-3 px-4 py-3">
                    <div class="flex min-w-0 flex-1 flex-col">
                        <span class="text-sm text-content">
                            {{ t(`app.settings.sources.${source.source}`) }}<span v-if="source.detail" class="text-muted"> · {{ source.detail }}</span>
                        </span>
                        <span class="text-2xs text-subtle">{{ t(`app.settings.sourceHelp.${source.source}`) }}</span>
                        <span class="text-2xs" :class="source.available ? `text-muted` : `text-subtle`">{{ sourceState(source) }}</span>
                    </div>
                    <Icon v-if="waiting === `source:${source.source}`" name="spinner" spin class="text-info" />
                    <Button
                        v-if="source.available && source.on && !source.ready"
                        tier="boring"
                        size="small"
                        :label="t(`app.settings.setUp`)"
                        :disabled="waiting !== undefined"
                        @click="setUp(source.source)"
                    />
                    <ToggleSwitch
                        :model-value="source.on"
                        :disabled="!source.available || waiting !== undefined"
                        :aria-label="t(`app.settings.sources.${source.source}`)"
                        @update:model-value="(on: boolean) => toggleSource(source, on)"
                    />
                </div>
            </div>
        </section>

        <section v-if="settings" class="flex flex-col gap-3">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.settings.unlock`) }}</h3>
            <p class="text-xs text-muted">{{ unlockNote }}</p>
            <div class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
                <label class="flex items-center gap-3 px-4 py-3">
                    <span class="flex-1 text-sm text-content">{{ t(`app.settings.autoLock`) }}</span>
                    <select :class="ui.input({ size: `sm` }, `w-auto`)" :value="settings.autoLockMinutes" :disabled="waiting !== undefined" @change="onLockMinutes">
                        <option v-for="option in lockOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </select>
                </label>
                <label class="flex items-center gap-3 px-4 py-3">
                    <span class="flex-1 text-sm text-content">{{ t(`app.settings.lockOnSleep`) }}</span>
                    <ToggleSwitch
                        :model-value="settings.lockOnSleep"
                        :disabled="waiting !== undefined"
                        @update:model-value="(on: boolean) => update(`sleep`, { lockOnSleep: on })"
                    />
                </label>
            </div>
        </section>

        <section class="flex flex-col gap-2">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.settings.recovery`) }}</h3>
            <p class="text-xs text-muted">{{ t(`app.settings.recoveryHelp`) }}</p>
        </section>

        <section v-if="settings" class="flex flex-col gap-2">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.settings.neverSave`) }}</h3>
            <p v-if="settings.neverSave.length === 0" class="text-xs text-muted">{{ t(`app.settings.neverSaveEmpty`) }}</p>
            <div v-else class="flex flex-wrap gap-1.5">
                <span v-for="origin in settings.neverSave" :key="originKey(origin)" :class="ui.chip(`gap-1 pr-1`)">
                    {{ originLabel(origin) }}
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `xs` })"
                        :aria-label="t(`app.edit.removePlace`, { place: originLabel(origin) })"
                        :disabled="waiting !== undefined"
                        @click="forget(origin)"
                    >
                        <Icon name="times" />
                    </button>
                </span>
            </div>
        </section>

        <section class="flex flex-col gap-2">
            <h3 :class="ui.sectionLabel({ size: `xs` })">{{ t(`app.settings.import`) }}</h3>
            <p class="text-xs text-muted">{{ t(`app.settings.importHelp`) }}</p>
            <ImportPanel :port="port" @imported="emit(`changed`)" />
        </section>
    </section>
</template>
