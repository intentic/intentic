<script setup lang="ts">
import type { DeviceSandboxOp } from "@intentic/sandbox-contract";
import {
    Button,
    ui,
    Code,
    commandLang,
    ConfirmDialog,
    DeviceRunLog,
    Notice,
    type NoticeModel,
    SegmentedControl,
    useOsPreference,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { manageDeviceSandbox, useHostRunning } from "../../sandbox/devices/useDevices";
import { DESKTOP_DOWNLOADS, desktopRecreateLink, desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";

// Recreating needs the host machine (the daemon has no host Docker socket for its own container), so this renders
// across four surfaces: a button on a connected device or the desktop app, else a copyable per-OS command. Mode
// rides the argument shape (a hash rebuilds that pinned overlay, no hash pulls :stable), not a flag. `Download` runs
// the same flow but stops before the container is touched.

type Action = `Download` | `Update` | `Rebuild` | `Roll back`;

const props = defineProps<{
    slug: string;
    // The approved overlay's sha256; present for a rebuild, absent otherwise.
    hash?: string;
    // What the button says; the command block's label and, for the three modes sharing the update script, which one
    // runs.
    action: Action;
    // Whether the needed image is already on that machine, so the wait is just the restart; supplied by the update
    // card.
    ready?: boolean;
}>();

const { cmdOs } = useOsPreference();
const desktop = computed(() => desktopVersion() !== undefined);

// The machine, when it is one this sandbox can ask directly.
const hostId = useHostRunning(() => props.slug);
const OP: Record<Action, DeviceSandboxOp> = { Download: `prepare`, Update: `update`, Rebuild: `rebuild`, "Roll back": `rollback` };

// What this action costs, read by all four renderings: the sandbox stays up through the download and rebuild, and
// only the final restart interrupts anything.
const cost = computed(() => {
    if (props.action === `Download`) {
        return `It downloads and builds the update in the background. Nothing restarts and nothing is interrupted: your sandbox keeps working throughout.`;
    }
    if (props.ready === true) {
        return `It is already downloaded, so this is just the restart: about half a minute. Your files (in /work) are kept.`;
    }
    return `It downloads and builds first, which interrupts nothing, then restarts your sandbox for about half a minute. Your files (in /work) are kept.`;
});

const running = ref(false);
const lines = ref<string[]>([]);
const failure = ref<NoticeModel | undefined>(undefined);
const done = ref<string | undefined>(undefined);

// Recreating always drops this page's connection, confirmed in-app (not the browser's confirm()) before it starts.
// `Download` skips confirmation since it never touches the container and costs nothing to abandon.
const confirming = ref(false);

const runOnMachine = (): void => {
    if (hostId.value === undefined || running.value) {
        return;
    }
    if (props.action === `Download`) {
        void execute();
        return;
    }
    confirming.value = true;
};

// Every sentence keeps the sandbox as the subject, not the device (a bare "it restarts on that device" reads as the
// device restarting); the device is named once, to say it's left alone.
const confirmHeader = computed(() => (props.action === `Roll back` ? `Roll this sandbox back?` : `${props.action} this sandbox?`));
const confirmBody = computed(() => {
    if (props.action === `Roll back`) {
        return `Your sandbox restarts onto the image it ran before its last update — about half a minute of downtime, then this page reconnects on its own.`;
    }
    if (props.ready === true) {
        return `The update is already downloaded, so this is just the restart: your sandbox is down for about half a minute, then this page reconnects on its own.`;
    }
    const work = props.action === `Rebuild` ? `Your environment is rebuilt first` : `The update is downloaded and built first`;
    return `${work} — your sandbox keeps working through that — and then your sandbox restarts for about half a minute, after which this page reconnects on its own.`;
});

const execute = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    if (id === undefined || running.value) {
        return;
    }
    running.value = true;
    failure.value = undefined;
    done.value = undefined;
    lines.value = [];
    try {
        done.value = await manageDeviceSandbox(id, props.slug, OP[props.action], {
            ...(props.hash === undefined ? {} : { hash: props.hash }),
            onLine: (line) => lines.value.push(line),
        });
    } catch (error) {
        failure.value = noticeFrom(error, `Couldn't rebuild this host.`);
    } finally {
        running.value = false;
    }
};

// Rollback rides the update script with a flag, exactly as rebuild does with its hash (recreate.sh/recreate.ps1's
// `-Rollback` switch).
const command = computed(() => {
    const key = props.hash === undefined ? `update` : `rebuild`;
    const rollback = props.action === `Roll back`;
    const download = props.action === `Download`;
    if (cmdOs.value === `windows`) {
        const args = rollback
            ? `-Slug ${props.slug} -Rollback`
            : download
              ? `-Slug ${props.slug} -Prepare`
              : props.hash === undefined
                ? `-Slug ${props.slug}`
                : `-Slug ${props.slug} -Hash ${props.hash}`;
        return psCommand(props.hash === undefined ? `updatePs1` : `rebuildPs1`, ``, args);
    }
    if (rollback) {
        return bashCommand(key, ``, `${props.slug} --rollback`);
    }
    if (download) {
        return bashCommand(key, ``, `${props.slug} --prepare`);
    }
    return bashCommand(key, ``, props.hash === undefined ? props.slug : `${props.slug} ${props.hash}`);
});
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- Machine is reachable from here, so this is a button wherever you're reading it, even a phone elsewhere. -->
        <template v-if="hostId">
            <Button
                :label="running ? `${action} running…` : `${action} now`"
                size="small"
                class="self-start"
                :severity="action === `Download` ? `secondary` : undefined"
                :loading="running"
                @click="runOnMachine"
            >
                <template #icon><Icon :name="action === `Download` ? `download` : `bolt`" /></template>
            </Button>
            <p class="text-2xs text-subtle">Runs on the device hosting this sandbox. {{ cost }}</p>
            <DeviceRunLog
                v-if="running || lines.length > 0"
                :lines="lines"
                :running="running"
                empty="Starting on that device…"
                note="Running on that device: it keeps going even if you leave this page."
            />
            <Notice v-if="failure" :of="failure" />
            <p v-else-if="done" class="text-2xs text-muted">{{ done }}</p>

            <!-- Not destructive: every action here keeps the sandbox's files and just moves it to another image. -->
            <ConfirmDialog
                :open="confirming"
                :header="confirmHeader"
                :confirm-label="`${action} now`"
                confirm-icon="bolt"
                :destructive="false"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <p>{{ confirmBody }}</p>
                <p class="mt-3 text-xs text-muted">
                    Only the sandbox restarts — nothing else on that device is touched. Your files (in /work) are kept.
                </p>
            </ConfirmDialog>
        </template>

        <!--
            Desktop deep link covers all three swaps including rollback. Download can't, since `intentic://recreate`
            has no
            parameter to stop before the container is touched, so it falls through to the command below instead.
        -->
        <template v-else-if="desktop && action !== `Download`">
            <Button
                :label="`${action} now`"
                size="small"
                class="self-start"
                @click="openDesktopLink(desktopRecreateLink(slug, hash, action === `Roll back`))"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">Runs here, on this device. {{ cost }}</p>
        </template>

        <template v-else>
            <ol class="ml-4 list-decimal text-2xs text-subtle">
                <li>Open a terminal on the device that runs your sandbox.</li>
                <li>Copy and run the command below. {{ cost }}</li>
            </ol>
            <SegmentedControl
                v-model="cmdOs"
                size="sm"
                class="self-start"
                :options="[
                    { label: `Linux / macOS`, value: `unix` },
                    { label: `Windows`, value: `windows` },
                ]"
            />
            <Code :code="command" :lang="commandLang(cmdOs)" :label="`${action} command`" :wrap="true" />
            <!--
                Offered here, not just at setup, since this is the moment reaching for the app repeatedly starts to pay
                off.
            -->
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                <span>Skip the terminal next time:</span>
                <a :href="DESKTOP_DOWNLOADS.windows" class="text-link hover:underline">Intentic for Windows</a>
                <span>·</span>
                <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="text-link hover:underline">Linux</a>
                <span>does this with a button.</span>
            </p>
        </template>
    </div>
</template>
