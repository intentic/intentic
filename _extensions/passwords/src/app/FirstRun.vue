<!-- Turning Passwords on: one permission, the recovery key shown once, the one yes to remembering, and an optional import. -->
<script setup lang="ts">
import { Button, CopyButton, Icon, messageOr, Notice, Checkbox } from "@intentic/extension-ui";
import { REMEMBER_NOTHING } from "@intentic/sandbox-contract/policy/keyring-origins";
import { computed, ref, shallowRef } from "vue";
import { t } from "../i18n.js";
import ImportPanel from "./ImportPanel.vue";
import type { PasswordsPort, SourceStatus, VaultStatus } from "./port.js";

const { port, status } = defineProps<{ port: PasswordsPort; status: Extract<VaultStatus, { kind: `not-set-up` }> | undefined }>();
const emit = defineEmits<{ done: [] }>();

type Step = `hero` | `recovery` | `existing` | `remember` | `import`;
const step = ref<Step>(`hero`);
const error = ref<string | undefined>(undefined);
const busy = ref(false);

const run = async (task: () => Promise<void>): Promise<void> => {
    busy.value = true;
    error.value = undefined;
    try {
        await task();
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
    } finally {
        busy.value = false;
    }
};

/* 1. THE ONE PERMISSION, and the recovery key it makes. */
const recoveryKey = ref<string | undefined>(undefined);
const keySaved = ref(false);
const sources = shallowRef<readonly SourceStatus[]>([]);
const turnOn = (): Promise<void> =>
    run(async () => {
        const made = await port.setUp({ hello: status?.hello ?? false });
        // No key: the vault was there already, and an empty "shown only now" key would read as a new one.
        recoveryKey.value = made.recoveryKey;
        step.value = made.recoveryKey === undefined ? `existing` : `recovery`;
    });

// A download says nothing where it lands (the desktop app's webview least of all), so the page says it.
const fileSaved = ref<string | undefined>(undefined);
const saveFile = (): void => {
    if (recoveryKey.value === undefined) {
        return;
    }
    const text = t(`app.first.fileText`, { computer: status?.computer ?? ``, key: recoveryKey.value });
    const link = document.createElement(`a`);
    link.href = URL.createObjectURL(new Blob([text], { type: `text/plain` }));
    link.download = t(`app.first.fileName`);
    link.click();
    // Revoked once the download has read it: revoking at once can cancel it.
    const href = link.href;
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    fileSaved.value = t(`app.first.fileSaved`, { file: link.download });
};

const toRemember = (): Promise<void> =>
    run(async () => {
        // Shown once: it leaves the page the moment the person has said they kept it.
        recoveryKey.value = undefined;
        fileSaved.value = undefined;
        sources.value = await port.sources();
        step.value = `remember`;
    });

/* 2. REMEMBERING: every source this computer can have, turned on together, then each set up in turn. */
const settingUp = ref<string | undefined>(undefined);
const available = computed(() => sources.value.filter((source) => source.available));
const rememberAll = (): Promise<void> =>
    run(async () => {
        await port.updateSettings({ remember: Object.fromEntries(available.value.map((source) => [source.source, true])) });
        for (const source of available.value.filter((candidate) => !candidate.ready)) {
            settingUp.value = t(`app.settings.sources.${source.source}`);
            await port.setUpSource(source.source);
        }
        settingUp.value = undefined;
        step.value = `import`;
    }).finally(() => {
        settingUp.value = undefined;
    });
// Each row says in a word what Turn on does for it, and only a source this computer cannot have adds a line: why.
const statusOf = (source: SourceStatus) => {
    if (!source.available) {
        return { label: t(`app.settings.unavailable`), tone: `text-subtle` };
    }
    if (source.ready) {
        return { label: t(`app.first.ready`), tone: `text-success` };
    }
    // A phone is paired from the phone itself, so Turn on leaves it to that.
    return source.source === `phone` ? { label: t(`app.first.pairOnPhone`), tone: `text-muted` } : { label: t(`app.first.willSetUp`), tone: `text-content` };
};
const notNow = (): Promise<void> =>
    run(async () => {
        await port.updateSettings({ remember: REMEMBER_NOTHING });
        step.value = `import`;
    });
</script>

<template>
    <div class="ui-softscroll flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-12">
        <div class="flex w-full max-w-lg flex-col gap-6">
            <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>

            <section v-if="step === `hero`" class="flex flex-col items-center gap-6 pt-10 text-center">
                <span class="flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-2xl text-primary-fill" aria-hidden="true"><Icon name="key" /></span>
                <p class="max-w-md text-xl font-semibold leading-snug text-content">{{ t(`app.first.hero`) }}</p>
                <p class="max-w-md text-sm text-muted">{{ status?.hello === false ? t(`app.first.permissionLinux`) : t(`app.first.permission`) }}</p>
                <Button tier="loud" :label="busy ? t(`app.first.settingUp`) : t(`app.first.turnOn`)" :disabled="status?.canSetUp === false" :loading="busy" @click="turnOn()" />
                <p v-if="status?.canSetUp === false && status.why" class="max-w-md text-xs text-warning">{{ status.why }}</p>
            </section>

            <section v-else-if="step === `recovery`" class="flex flex-col gap-4">
                <h2 class="text-lg font-semibold text-content">{{ t(`app.first.recoveryTitle`) }}</h2>
                <p class="text-sm text-muted">{{ status?.hello === false ? t(`app.first.recoveryHelpNoHello`) : t(`app.first.recoveryHelp`) }}</p>
                <code class="block select-all break-all rounded-xl border border-line-subtle bg-card px-4 py-4 text-center font-mono text-base tracking-wide text-content">{{ recoveryKey }}</code>
                <div class="flex flex-wrap gap-2">
                    <CopyButton :text="recoveryKey ?? ``" :label="t(`app.detail.copy`)" />
                    <Button tier="boring" size="small" :label="t(`app.first.saveFile`)" @click="saveFile()">
                        <template #icon><Icon name="download" /></template>
                    </Button>
                </div>
                <p v-if="fileSaved" class="text-xs text-success" role="status">{{ fileSaved }}</p>
                <label class="flex items-center gap-2 text-sm text-content">
                    <Checkbox v-model="keySaved" binary :input-id="`recovery-saved`" />
                    {{ t(`app.first.saved`) }}
                </label>
                <Button tier="accent" class="self-end" :label="t(`app.first.continue`)" :disabled="!keySaved" :loading="busy" @click="toRemember()" />
            </section>

            <section v-else-if="step === `existing`" class="flex flex-col gap-4">
                <h2 class="text-lg font-semibold text-content">{{ t(`app.first.existingTitle`) }}</h2>
                <p class="text-sm text-muted">{{ t(`app.first.existingHelp`) }}</p>
                <Button tier="accent" class="self-end" :label="t(`app.first.continue`)" @click="emit(`done`)" />
            </section>

            <section v-else-if="step === `remember`" class="flex flex-col gap-4">
                <h2 class="text-lg font-semibold text-content">{{ t(`app.first.rememberTitle`) }}</h2>
                <p class="text-sm text-muted">{{ t(`app.first.rememberHelp`) }}</p>
                <ul class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
                    <li v-for="source in sources" :key="source.source" class="flex flex-col gap-0.5 px-4 py-3" :class="source.available ? `` : `opacity-60`">
                        <div class="flex items-baseline gap-3">
                            <span class="min-w-0 flex-1 text-sm font-medium text-content">
                                {{ t(`app.settings.sources.${source.source}`) }}<span v-if="source.detail" class="ml-2 text-xs font-normal text-muted">{{ source.detail }}</span>
                            </span>
                            <span class="shrink-0 whitespace-nowrap text-xs" :class="statusOf(source).tone">{{ statusOf(source).label }}</span>
                        </div>
                        <p class="text-xs text-muted">{{ t(`app.settings.sourceHelp.${source.source}`) }}</p>
                        <p v-if="!source.available && source.why" class="text-xs text-warning">{{ source.why }}</p>
                    </li>
                </ul>
                <p v-if="settingUp" class="flex items-center gap-1.5 text-xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.first.settingSource`, { source: settingUp }) }}</p>
                <div class="flex justify-end gap-2">
                    <Button tier="quiet" :label="t(`app.first.notNow`)" :disabled="busy" @click="notNow()" />
                    <Button tier="loud" :label="t(`app.first.turnOnRemember`)" :loading="busy" :disabled="available.length === 0" @click="rememberAll()" />
                </div>
            </section>

            <section v-else class="flex flex-col gap-4">
                <h2 class="text-lg font-semibold text-content">{{ t(`app.first.importTitle`) }}</h2>
                <p class="text-sm text-muted">{{ t(`app.first.importHelp`) }}</p>
                <ImportPanel :port="port" />
                <div class="flex justify-end gap-2">
                    <Button tier="accent" :label="t(`app.first.finish`)" @click="emit(`done`)" />
                </div>
            </section>
        </div>
    </div>
</template>
