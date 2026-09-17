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
import { useSandbox } from "../../sandbox/client/useSandbox";
import { expectRestart, type RestartQuiet } from "../../sandbox/live/sandboxRestart";
import { useHubWork } from "../../../shell/hub/hubWork";
import ConnectDeviceHint from "../../sandbox/devices/ConnectDeviceHint.vue";
import { desktopRecreateLink, desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { DESKTOP_DOWNLOADS } from "../../../app/environments/desktopDownloads";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import { useT } from "@intentic/ui/i18n";

// Recreating needs the host machine (the daemon has no host Docker socket for its own container), so this renders
// across four surfaces: a button on a connected device or the desktop app, else a copyable per-OS command. Mode
// rides the argument shape (a hash rebuilds that pinned overlay, no hash pulls :stable), not a flag. `Download` runs
// the same flow but stops before the container is touched.

const t = useT();

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
const { activeSandboxId, reachable } = useSandbox();
const desktop = computed(() => desktopVersion() !== undefined);

// The machine, when it is one this sandbox can ask directly.
const hostId = useHostRunning(() => props.slug);
const OP: Record<Action, DeviceSandboxOp> = { Download: `prepare`, Update: `update`, Rebuild: `rebuild`, "Roll back": `rollback` };

// The action as a reader sees it. `Action` is the enum this component switches on and the script it runs, so its
// members are not the words on screen: every label takes this instead.
const VERBS: Record<Action, string> = { Download: `download`, Update: `update`, Rebuild: `rebuild`, "Roll back": `rollBack` };
const verb = computed(() => t(`capabilities.hostRecreate.${VERBS[props.action]}Verb` as `capabilities.hostRecreate.updateVerb`));

// What this action costs, read by all four renderings: the sandbox stays up through the download and rebuild, and
// only the final restart interrupts anything.
const cost = computed(() => {
    if (props.action === `Download`) {
        return t(`capabilities.hostRecreate.costDownload`);
    }
    if (props.ready === true) {
        return t(`capabilities.hostRecreate.costRestartOnly`);
    }
    return t(`capabilities.hostRecreate.costBuildThenRestart`);
});

// What the hub row this is rendered on says while the machine works: the same button sits on Environment and on
// Overview's update card, and each reports where it was pressed.
const workingWords = (): Record<Action, string> => ({
    Download: t(`capabilities.hostRecreate.workingDownload`),
    Update: t(`capabilities.hostRecreate.workingUpdate`),
    Rebuild: t(`capabilities.hostRecreate.workingRebuild`),
    "Roll back": t(`capabilities.hostRecreate.workingRollBack`),
});
const hubWork = useHubWork();

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
const confirmHeader = computed(() =>
    props.action === `Roll back`
        ? t(`capabilities.hostRecreate.rollBackHeader`)
        : t(`capabilities.hostRecreate.actionHeader`, { action: verb.value }),
);
const confirmBody = computed(() => {
    if (props.action === `Roll back`) {
        return t(`capabilities.hostRecreate.confirmRollBack`);
    }
    if (props.ready === true) {
        return t(`capabilities.hostRecreate.confirmRestartOnly`);
    }
    const work = props.action === `Rebuild` ? t(`capabilities.hostRecreate.workRebuilt`) : t(`capabilities.hostRecreate.workDownloaded`);
    return t(`capabilities.hostRecreate.confirmBuildThenRestart`, { work });
});

// What the sandbox going quiet means while this runs, for every surface that isn't this card. `Download` is absent
// on purpose: it never touches the container, so a silence during one is not this button's doing.
const QUIET = computed((): Partial<Record<Action, RestartQuiet>> => ({
    Update: {
        title: t(`capabilities.hostRecreate.restartingOntoUpdate`),
        detail: t(`capabilities.hostRecreate.updateAppliedReplacesSandboxs`),
    },
    Rebuild: {
        title: t(`capabilities.hostRecreate.restartingOntoRebuiltEnvironment`),
        detail: t(`capabilities.hostRecreate.environmentApprovedBeingSwapped`),
    },
    "Roll back": {
        title: t(`capabilities.hostRecreate.rollingSandboxBack`),
        detail: t(`capabilities.hostRecreate.restartingOntoImageRan`),
    },
}));

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
    // Armed for the whole op, not just its restart: the machine gives no sign of which minute the swap falls in, and
    // an expectation costs nothing while the sandbox is still answering.
    const quiet = QUIET.value[props.action];
    const sandbox = activeSandboxId.value;
    const expecting = quiet !== undefined && sandbox !== undefined;
    const working = expecting ? expectRestart({ sandbox, id: `recreate`, what: workingWords()[props.action], quiet }) : undefined;
    let swapping = false;
    try {
        done.value = await hubWork.track(workingWords()[props.action], () =>
            manageDeviceSandbox(id, props.slug, OP[props.action], {
                ...(props.hash === undefined ? {} : { hash: props.hash }),
                onLine: (line) => lines.value.push(line),
            }),
        );
        swapping = true;
    } catch (error) {
        // THIS REQUEST DIES WITH THE CONTAINER IT REPLACES: it is relayed by the daemon that the recreate throws
        // away, so a failure here is as likely to BE the restart as to be a refusal of one. A sandbox that is still
        // answering is what tells the two apart — nothing was replaced, so nothing is coming back.
        swapping = !reachable.value;
        failure.value = noticeFrom(error, `Couldn't rebuild this host.`);
    } finally {
        running.value = false;
        working?.();
        // Handed to the sandbox's own return: this page cannot see the container come up, and the ledger's record is
        // what every other surface reads the silence by until it does.
        if (swapping && expecting) {
            expectRestart({ sandbox, id: `recreate`, what: workingWords()[props.action], quiet, untilAnswered: true });
        }
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
                :label="running ? t(`capabilities.hostRecreate.running`, { action: verb }) : t(`capabilities.hostRecreate.now`, { action: verb })"
                size="small"
                class="self-start"
                :severity="action === `Download` ? `secondary` : undefined"
                :loading="running"
                @click="runOnMachine"
            >
                <template #icon><Icon :name="action === `Download` ? `download` : `bolt`" /></template>
            </Button>
            <p class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.runsOnDeviceHosting`, { cost }) }}</p>
            <DeviceRunLog
                v-if="running || lines.length > 0"
                :lines="lines"
                :running="running"
                :empty="t(`capabilities.hostRecreate.startingOnDevice`)"
                :note="t(`capabilities.hostRecreate.runningOnDeviceKeeps`)"
            />
            <Notice v-if="failure" :of="failure" />
            <p v-else-if="done" class="text-2xs text-muted">{{ done }}</p>

            <!-- Not destructive: every action here keeps the sandbox's files and just moves it to another image. -->
            <ConfirmDialog
                :open="confirming"
                :header="confirmHeader"
                :confirm-label="t(`capabilities.hostRecreate.now`, { action: verb })"
                confirm-icon="bolt"
                :destructive="false"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <p>{{ confirmBody }}</p>
                <p class="mt-3 text-xs text-muted">
                    {{ t(`capabilities.hostRecreate.onlySandboxRestartsNothing`) }}
                </p>
            </ConfirmDialog>
        </template>

        <!-- Desktop deep link covers all three swaps including rollback. -->
        <template v-else-if="desktop && action !== `Download`">
            <Button
                :label="t(`capabilities.hostRecreate.now`, { action: verb })"
                size="small"
                class="self-start"
                @click="openDesktopLink(desktopRecreateLink(slug, hash, action === `Roll back`))"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.runsHereOnDevice`, { cost }) }}</p>
        </template>

        <template v-else>
            <ol class="ml-4 list-decimal text-2xs text-subtle">
                <li>{{ t(`capabilities.hostRecreate.openTerminalOnDevice`) }}</li>
                <li>{{ t(`capabilities.hostRecreate.copyRunCommandBelow`, { cost }) }}</li>
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
            <Code :code="command" :lang="commandLang(cmdOs)" :label="t(`capabilities.hostRecreate.command`, { action: verb })" :wrap="true" />
            <!-- The cheaper way out where it exists: the machine is already talking to this sandbox, and one card turns that into the button above. -->
            <ConnectDeviceHint :slug="slug" :gains="t(`capabilities.hostRecreate.becomesButtonHere`, { action: verb })" />
            <!-- Offered here, not just at setup, since this is the moment reaching for the app repeatedly starts to pay off. -->
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                <span>{{ t(`capabilities.hostRecreate.skipTerminalNextTime`) }}</span>
                <a :href="DESKTOP_DOWNLOADS.windows" class="text-link hover:underline">{{ t(`capabilities.hostRecreate.intenticWindows`) }}</a>
                <span>·</span>
                <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="text-link hover:underline">Linux</a>
                <span>{{ t(`capabilities.hostRecreate.doesButton`) }}</span>
            </p>
        </template>
    </div>
</template>
