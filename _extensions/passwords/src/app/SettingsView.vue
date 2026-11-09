<!-- Passwords' settings on this computer: where passwords are remembered from, how it unlocks and locks (Windows Hello, the master password), the recovery key, places never saved for, and import. -->
<script setup lang="ts">
import { Button, Icon, messageOr, Notice, Section, ToggleSwitch, ui } from "@intentic/extension-ui";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { originKey } from "@intentic/sandbox-contract/policy/keyring-origins";
import { computed, onMounted, ref, shallowRef } from "vue";
import { t } from "../i18n.js";
import ImportPanel from "./ImportPanel.vue";
import type { PasswordsPort, PasswordsSettings, PasswordsSettingsPatch, RememberSource, SourceStatus, UnlockWay } from "./port.js";
import { originLabel } from "./words.js";

const {
    port,
    unlock,
    helloAddable = false,
    masterPassword,
} = defineProps<{
    port: PasswordsPort;
    unlock: readonly UnlockWay[];
    /** Windows Hello signs here and the vault was set up without it. */
    helloAddable?: boolean;
    /** Whether a master password is set; undefined where the keyring cannot keep one. */
    masterPassword?: boolean | undefined;
}>();
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

const unlockNote = computed(() => {
    if (unlock.includes(`hello`)) {
        return t(`app.settings.hello`);
    }
    if (unlock.includes(`polkit`)) {
        return t(`app.settings.polkit`);
    }
    return masterPassword === true ? t(`app.settings.master`) : t(`app.settings.passphrase`);
});

/* WINDOWS HELLO, turned on for a vault set up without it. */
const addHello = (): Promise<void> => act(`hello`, async () => await port.addHello?.());

/* THE MASTER PASSWORD: typed twice in a small form of its own, sent once, never kept on the page after. */
const MASTER_MIN = 10;
const canMaster = computed(() => masterPassword !== undefined && port.setMasterPassword !== undefined);
const masterOpen = ref(false);
const masterDraft = ref(``);
const masterAgain = ref(``);
const masterProblem = computed(() => {
    if (masterDraft.value.length > 0 && [...masterDraft.value].length < MASTER_MIN) {
        return t(`app.settings.masterShort`, { count: MASTER_MIN });
    }
    return masterAgain.value.length > 0 && masterAgain.value !== masterDraft.value ? t(`app.settings.masterMismatch`) : undefined;
});
const masterReady = computed(() => [...masterDraft.value].length >= MASTER_MIN && masterAgain.value === masterDraft.value);
const closeMaster = (): void => {
    masterOpen.value = false;
    masterDraft.value = ``;
    masterAgain.value = ``;
};
const saveMaster = (): Promise<void> =>
    act(`master`, async () => {
        await port.setMasterPassword?.(masterDraft.value);
        closeMaster();
    });
const removeMaster = (): Promise<void> => act(`master`, async () => await port.removeMasterPassword?.());

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
            <Section :label="t(`app.settings.remember`)" :heading="3">
                <p class="text-xs text-muted">{{ t(`app.settings.rememberHelp`) }}</p>
            </Section>
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

        <Section v-if="settings" :label="t(`app.settings.unlock`)" :heading="3">
            <div class="flex flex-col gap-3">
                <p class="text-xs text-muted">{{ unlockNote }}</p>
                <div class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
                    <div v-if="helloAddable && port.addHello" class="flex items-center gap-3 px-4 py-3">
                        <div class="flex min-w-0 flex-1 flex-col">
                            <span class="text-sm text-content">{{ t(`app.settings.helloOff`) }}</span>
                            <span class="text-2xs text-subtle">{{ t(`app.settings.helloOffHelp`) }}</span>
                        </div>
                        <Button tier="accent" size="small" :label="t(`app.hello.turnOn`)" :loading="waiting === `hello`" :disabled="waiting !== undefined" @click="addHello()" />
                    </div>
                    <div v-if="canMaster" class="flex flex-col gap-3 px-4 py-3">
                        <div class="flex items-center gap-3">
                            <div class="flex min-w-0 flex-1 flex-col">
                                <span class="text-sm text-content">{{ t(`app.settings.masterTitle`) }}</span>
                                <span class="text-2xs text-subtle">{{ masterPassword ? t(`app.settings.masterOn`) : t(`app.settings.masterOff`) }}</span>
                            </div>
                            <template v-if="!masterOpen">
                                <button
                                    v-if="masterPassword && port.removeMasterPassword"
                                    type="button"
                                    :class="ui.textButton({ size: `xs`, tone: `quiet` })"
                                    :disabled="waiting !== undefined"
                                    @click="removeMaster()"
                                >
                                    {{ t(`app.settings.masterRemove`) }}
                                </button>
                                <Button
                                    tier="boring"
                                    size="small"
                                    :label="masterPassword ? t(`app.settings.masterChange`) : t(`app.settings.masterSet`)"
                                    :disabled="waiting !== undefined"
                                    @click="masterOpen = true"
                                />
                            </template>
                        </div>
                        <form v-if="masterOpen" class="flex max-w-sm flex-col gap-2" @submit.prevent="masterReady && saveMaster()">
                            <input
                                v-model="masterDraft"
                                type="password"
                                autocomplete="new-password"
                                :class="ui.input({ size: `sm` })"
                                :placeholder="t(`app.settings.masterNew`)"
                                :aria-label="t(`app.settings.masterNew`)"
                            />
                            <input
                                v-model="masterAgain"
                                type="password"
                                autocomplete="new-password"
                                :class="ui.input({ size: `sm` })"
                                :placeholder="t(`app.settings.masterAgain`)"
                                :aria-label="t(`app.settings.masterAgain`)"
                            />
                            <p class="text-2xs" :class="masterProblem ? `text-danger` : `text-subtle`">{{ masterProblem ?? t(`app.settings.masterHelp`, { count: MASTER_MIN }) }}</p>
                            <div class="flex justify-end gap-2">
                                <button type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="closeMaster()">{{ t(`app.cancel`) }}</button>
                                <Button type="submit" tier="accent" size="small" :label="t(`app.save`)" :loading="waiting === `master`" :disabled="!masterReady || waiting !== undefined" />
                            </div>
                        </form>
                    </div>
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
            </div>
        </Section>

        <Section :label="t(`app.settings.recovery`)" :heading="3">
            <p class="text-xs text-muted">{{ t(`app.settings.recoveryHelp`) }}</p>
        </Section>

        <Section v-if="settings" :label="t(`app.settings.neverSave`)" :heading="3">
            <p v-if="settings.neverSave.length === 0" class="text-xs text-muted">{{ t(`app.settings.neverSaveEmpty`) }}</p>
            <div v-else class="flex flex-wrap gap-1.5">
                <span v-for="origin in settings.neverSave" :key="originKey(origin)" :class="ui.chip({ trail: true })">
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
        </Section>

        <Section :label="t(`app.settings.import`)" :heading="3">
            <div class="flex flex-col gap-2">
                <p class="text-xs text-muted">{{ t(`app.settings.importHelp`) }}</p>
                <ImportPanel :port="port" @imported="emit(`changed`)" />
            </div>
        </Section>
    </section>
</template>
