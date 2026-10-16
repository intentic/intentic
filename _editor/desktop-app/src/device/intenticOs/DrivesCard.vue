<script setup lang="ts">
import type { IntenticOsDrive } from "@intentic/sandbox-contract/schemas/intentic-os";
import { Button, lessMotion, Meter, Notice, Picker, StatusBadge, ui } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { revealLog } from "../../desktop";
import { onScreen } from "../../onScreen";
import { sandboxes } from "../machine";
import { copyDrive, copyEnd, copyError, copying, dismissCopy, drives, ejected, ejectDrive, ejectError, ejecting, markSeen, stopCopy } from "./drives";
import { copySaidOf, copyTargetsOf, driveNameOf, folderOf, folderRefused, placeOf, shareOf } from "./drivesCard";

// THE DRIVES A PERSON PLUGS IN, on This computer when this computer runs Intentic OS (drives.ts holds them, the app's
// os_settings.rs watches `ic os drives`): each USB drive and memory card by its name and size, a copy of everything on it
// into one of the sandboxes on this computer (into a folder of the reader's, or a new one in Imports), its progress for
// as long as it takes, where it went, and Eject. A drive plugged in since the reader last looked is lit up, and This
// device brings the card into view for it; once the card has been on screen a few seconds it is news no more, and the
// app takes its notification down.

const t = useT();

/** How long a new drive stays lit up on screen before it counts as seen. */
const SEEN_AFTER_MS = 4000;

const list = computed(() => drives.value?.drives ?? []);
const fresh = computed(() => drives.value?.fresh ?? []);
const targets = computed(() => copyTargetsOf(sandboxes.value));
const targetOptions = computed(() => targets.value.map((target) => ({ value: target.slug, label: target.name })));
const sandboxName = (slug: string): string => targets.value.find((target) => target.slug === slug)?.name ?? slug;

const kindWord = (drive: IntenticOsDrive): string => t(`desktop.os.drives.kind.${drive.kind}`);
const nameOf = (drive: IntenticOsDrive): string => driveNameOf(drive) ?? kindWord(drive);
const deviceName = (device: string): string => {
    const drive = list.value.find((each) => each.device === device);
    return drive === undefined ? t(`desktop.os.drives.kind.other`) : nameOf(drive);
};
const summary = computed(() => (list.value.length === 0 ? t(`desktop.os.drives.nothing`) : t(`desktop.os.drives.count`, { count: list.value.length }, list.value.length)));

/* COPY INTO…: the sandbox, and a folder inside it where the reader names one. */
const choosing = ref<string | undefined>(undefined);
const target = ref<string | undefined>(undefined);
const folder = ref(``);
const choose = (device: string): void => {
    choosing.value = device;
    folder.value = ``;
    // One sandbox is the only place it can go: it is chosen already.
    target.value = targets.value.length === 1 ? targets.value[0]?.slug : undefined;
};
const refused = computed(() => folderRefused(folder.value));
const copy = (): void => {
    const device = choosing.value;
    const slug = target.value;
    if (device === undefined || slug === undefined || refused.value) {
        return;
    }
    choosing.value = undefined;
    void copyDrive(device, slug, folderOf(folder.value));
};

const share = computed(() => (copying.value === undefined ? undefined : shareOf(copying.value)));
const progressLine = computed(() => {
    const now = copying.value;
    if (now === undefined || now.total === 0) {
        return t(`desktop.os.drives.starting`);
    }
    return t(`desktop.os.drives.progress`, { done: formatBytes(now.bytes), total: formatBytes(now.total) });
});
const said = computed(() => copySaidOf(copyEnd.value));
const copiedLine = computed(() => {
    const copied = copyEnd.value?.copied;
    if (copied === null || copied === undefined) {
        return copyEnd.value === undefined ? `` : t(`desktop.os.drives.copiedSome`, { sandbox: sandboxName(copyEnd.value.sandbox) });
    }
    return t(
        `desktop.os.drives.copied`,
        { count: copied.files, size: formatBytes(copied.bytes), sandbox: sandboxName(copied.sandbox), place: placeOf(copied.path) },
        copied.files,
    );
});
const showLog = async (path: string): Promise<void> => {
    try {
        await revealLog(path);
    } catch (error) {
        console.error(`[device] the copy's log could not be shown:`, error);
    }
};

/* WHAT IS NEW: brought into view as This device opens on it, and seen once it has been on screen a while. */
const root = ref<HTMLElement | null>(null);
const inView = ref(false);
let observer: IntersectionObserver | undefined;
let seenTimer: ReturnType<typeof setTimeout> | undefined;

const bringIntoView = (): void => {
    if (fresh.value.length > 0 && onScreen.value) {
        root.value?.scrollIntoView({ block: `start`, behavior: lessMotion() ? `auto` : `smooth` });
    }
};
onMounted(() => {
    bringIntoView();
    if (root.value !== null && `IntersectionObserver` in globalThis) {
        observer = new IntersectionObserver((entries) => (inView.value = entries.some((entry) => entry.isIntersecting)), { threshold: 0.5 });
        observer.observe(root.value);
    }
});
onBeforeUnmount(() => {
    observer?.disconnect();
    clearTimeout(seenTimer);
});
// The window shown again (a press on the notification brings it up): the new drive comes into view.
watch(onScreen, (shown) => shown && bringIntoView());
watch(
    () => [inView.value && onScreen.value, fresh.value.join(`\n`)] as const,
    ([seeing]) => {
        clearTimeout(seenTimer);
        const news = [...fresh.value];
        if (seeing && news.length > 0) {
            seenTimer = setTimeout(() => void markSeen(news), SEEN_AFTER_MS);
        }
    },
    { immediate: true },
);
</script>

<template>
    <section
        ref="root"
        class="flex scroll-mt-4 flex-col gap-3 rounded-xl p-4"
        :class="fresh.length > 0 || copying ? `bg-card shadow-sm` : `border border-line`"
        :aria-busy="copying !== undefined"
        data-os-drives
    >
        <header class="flex items-start gap-2.5">
            <Icon :name="copying ? `spinner` : `save`" :spin="copying !== undefined" class="mt-0.5 shrink-0 text-link" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.drives.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ summary }}</p>
            </div>
        </header>

        <p v-if="list.length === 0 && !copying" class="text-2xs text-subtle">{{ t(`desktop.os.drives.none`) }}</p>

        <ul v-else class="flex flex-col gap-2">
            <li
                v-for="drive in list"
                :key="drive.device"
                class="flex flex-col gap-2 rounded-lg border p-3 transition-colors"
                :class="fresh.includes(drive.device) ? `border-primary-500` : `border-line`"
            >
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Icon :name="drive.kind === `card` ? `camera` : `save`" class="shrink-0 text-subtle" />
                    <div class="min-w-0 flex-1">
                        <p class="flex items-center gap-2 text-xs font-medium text-content">
                            <span class="min-w-0 truncate">{{ nameOf(drive) }}</span>
                            <StatusBadge v-if="fresh.includes(drive.device)" class="shrink-0" size="xs" variant="primary" :label="t(`desktop.os.drives.new`)" />
                        </p>
                        <p class="mt-0.5 text-2xs text-subtle">
                            {{ driveNameOf(drive) === undefined ? formatBytes(drive.size) : `${kindWord(drive)} · ${formatBytes(drive.size)}` }}
                        </p>
                    </div>
                    <template v-if="copying?.device !== drive.device && choosing !== drive.device">
                        <Button
                            size="small"
                            :tier="fresh.includes(drive.device) ? `accent` : `boring`"
                            :label="t(`desktop.os.drives.copyInto`)"
                            :disabled="copying !== undefined || ejecting !== undefined"
                            @click="choose(drive.device)"
                        >
                            <template #icon><Icon name="download" /></template>
                        </Button>
                        <Button
                            size="small"
                            tier="quiet"
                            :label="ejecting === drive.device ? t(`desktop.os.drives.ejecting`) : t(`desktop.os.drives.eject`)"
                            :loading="ejecting === drive.device"
                            :disabled="copying !== undefined || ejecting !== undefined"
                            @click="ejectDrive(drive.device, nameOf(drive))"
                        >
                            <template #icon><Icon name="upload" /></template>
                        </Button>
                    </template>
                </div>

                <!-- COPY INTO…: which sandbox, and a folder inside it if the reader wants one. -->
                <form v-if="choosing === drive.device" class="flex flex-col gap-2" @submit.prevent="copy">
                    <p v-if="targets.length === 0" class="text-2xs text-subtle">{{ t(`desktop.os.drives.noSandbox`) }}</p>
                    <template v-else>
                        <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-2xs text-subtle">{{ t(`desktop.os.drives.into`) }}</span>
                            <Picker
                                v-model="target"
                                :options="targetOptions"
                                variant="input"
                                :placeholder="t(`desktop.os.drives.pickSandbox`)"
                                :aria-label="t(`desktop.os.drives.into`)"
                                :header="t(`desktop.os.drives.into`)"
                                class="ui-field-sm w-full"
                            />
                        </div>
                        <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-2xs text-subtle">{{ t(`desktop.os.drives.folder`) }}</span>
                            <input
                                v-model="folder"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                :placeholder="t(`desktop.os.drives.folderExample`)"
                                :aria-label="t(`desktop.os.drives.folder`)"
                                :class="ui.input({ size: `sm` }, `w-full`)"
                            />
                            <span v-if="refused" class="text-2xs text-warning">{{ t(`desktop.os.drives.folderRefused`) }}</span>
                            <span v-else class="text-2xs text-subtle">{{ t(`desktop.os.drives.folderHint`) }}</span>
                        </div>
                    </template>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button v-if="targets.length > 0" size="small" :label="t(`desktop.os.drives.copy`)" :disabled="target === undefined || refused" @click="copy" />
                        <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="choosing = undefined" />
                    </div>
                </form>
            </li>
        </ul>

        <!-- A COPY UNDER WAY, this window's or another's: how far it has got, and the way to stop it. -->
        <div v-if="copying" class="flex flex-col gap-2">
            <p class="text-xs font-medium text-content">
                {{ t(`desktop.os.drives.copying`, { name: deviceName(copying.device), sandbox: sandboxName(copying.sandbox) }) }}
            </p>
            <Meter :value="share" size="md" class="w-full" :label="t(`desktop.os.drives.copyingShort`)" :valuetext="progressLine" />
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="min-w-0 flex-1 text-2xs text-subtle tabular-nums">{{ progressLine }} · {{ t(`desktop.os.drives.keepsGoing`) }}</span>
                <Button size="small" tier="quiet" :label="t(`desktop.os.drives.stop`)" @click="stopCopy">
                    <template #icon><Icon name="stop" /></template>
                </Button>
            </div>
        </div>

        <!-- HOW THE LAST COPY ENDED. A stop the reader asked for says nothing. -->
        <Notice v-if="said === `copied`" tone="success" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissCopy">{{ copiedLine }}</Notice>
        <Notice v-else-if="said === `noRoom` && copyEnd" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissCopy">
            <span class="block font-medium">{{ t(`desktop.os.drives.noRoom`, { sandbox: sandboxName(copyEnd.sandbox) }) }}</span>
            <span v-if="copyEnd.reason" class="mt-0.5 block text-2xs">{{ copyEnd.reason }}</span>
        </Notice>
        <Notice v-else-if="said === `busy`" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissCopy">
            {{ t(`desktop.os.drives.busy`) }}
        </Notice>
        <Notice v-else-if="said === `notOs`" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissCopy">
            {{ t(`desktop.os.drives.notOs`) }}
        </Notice>
        <Notice v-else-if="said === `failed` && copyEnd" tone="danger" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissCopy">
            <span class="block font-medium">{{ t(`desktop.os.drives.didntFinish`) }}</span>
            <span v-if="copyEnd.reason" class="mt-0.5 block font-mono text-2xs break-words">{{ copyEnd.reason }}</span>
            <button v-if="copyEnd.log" type="button" :class="ui.textButton({ tone: `quiet` }, `mt-1`)" @click="showLog(copyEnd.log)">
                {{ t(`desktop.os.showLog`) }}
            </button>
        </Notice>
        <Notice v-else-if="copyError" tone="danger" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissCopy">
            <span class="block font-medium">{{ t(`desktop.os.drives.didntStart`) }}</span>
            <span class="mt-0.5 block font-mono text-2xs break-words">{{ copyError }}</span>
        </Notice>

        <!-- EJECTED, or not. -->
        <Notice v-if="ejected" tone="success" icon="check-circle" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="ejected = undefined">
            {{ t(`desktop.os.drives.ejected`, { name: ejected }) }}
        </Notice>
        <Notice v-if="ejectError" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="ejectError = undefined">
            <span class="block font-medium">{{ t(`desktop.os.drives.couldNotEject`, { name: ejectError.name }) }}</span>
            <span class="mt-0.5 block font-mono text-2xs break-words">{{ ejectError.reason }}</span>
        </Notice>
    </section>
</template>
