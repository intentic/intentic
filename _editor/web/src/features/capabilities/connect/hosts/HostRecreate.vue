<script setup lang="ts">
import type { DeviceSandboxOp } from "@intentic/sandbox-contract";
import {
    Button,
    ui,
    Code,
    commandLang,
    ConfirmDialog,
    DeviceRunLog,
    type IconName,
    Notice,
    type NoticeModel,
    SegmentedControl,
    useOsPreference,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import { computed, onBeforeUnmount, ref, type VNode, watch } from "vue";
import { type DeviceSandboxPayload, manageDeviceSandbox, swapServingSandbox, useHostRunning } from "../../../sandbox/devices/useDevices";
import { useSandbox } from "../../../sandbox/client/useSandbox";
import { expectRestart, type RestartQuiet } from "../../../sandbox/live/sandboxRestart";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandboxSettings } from "../../../sandbox/overview/useSandboxSettings";
import { appliedHash, runningVersion } from "./swapLanding";
import { useRebuildWhenIdle } from "./useRebuildWhenIdle";
import ConnectDeviceHint from "../../../sandbox/devices/ConnectDeviceHint.vue";
import { desktopRecreateLink, desktopVersion, openDesktopLink } from "../../../../app/environments/desktop";
import { DESKTOP_DOWNLOADS } from "../../../../app/environments/desktopDownloads";
import { bashCommand, psCommand } from "../../../../app/environments/scriptCommand";
import { useT } from "@intentic/ui/i18n";

// Recreating needs the host machine (the daemon has no host Docker socket for its own container), so this renders
// across four surfaces: a button on a connected device or the desktop app, else a copyable per-OS command. Mode
// rides the argument shape (a hash rebuilds that pinned overlay, no hash pulls :stable), not a flag. `Download` runs
// the same flow but stops before the container is touched.
//
// Every caller hands it the slug of the sandbox serving this page (read off its own /environment), so every swap run
// from here is relayed by the very daemon it replaces: the stream dies at the cutover. That is the swap happening, not
// contact lost, so the button waits for the sandbox to come back and then gets out of the way; what the swap did is
// read off the sandbox that answered (the update card's `lastUpdate`).

const t = useT();

type Action = `Download` | `Update` | `Rebuild` | `Roll back`;

// Action members for template comparisons: the i18n gate reads bound-attribute expressions, not enum switches.
const DOWNLOAD: Action = `Download`;

const props = defineProps<{
    slug: string;
    // The approved overlay's sha256; present for a rebuild, absent otherwise.
    hash?: string;
    // What the button says; the command block's label and, for the three modes sharing the update script, which one
    // runs.
    action: Action;
    // Whether the needed image is already on that machine, so the wait is just the restart; supplied by the update
    // tile.
    ready?: boolean;
    // A text button, a tier below the step it sits beside; the update tile lays out download beside update.
    text?: boolean;
    // No cost line beneath the button and no column of its own: the caller says the cost once (the update tile) or
    // leaves it to the confirmation (the Environment card), and lays the pieces out itself.
    bare?: boolean;
    // The button's own words when the caller has better ones than "{action} now": "Try again" for an update the
    // machine already gave up on once.
    label?: string;
    // The caller says what the swap keeps (the update card's reassurance under its button), so the cost here says only
    // what it costs rather than saying the files are kept a second time.
    keepsSaid?: boolean;
    // The update card's own button: cast in the house gold at full size, since it is the one thing that page asks of
    // anyone. The caller states the cost beside it, so no line here repeats it, and on a machine this page cannot reach
    // the command waits behind the button (`open`) instead of being printed at whoever opens the page.
    gilded?: boolean;
}>();
// The sandbox answered again after a swap this ran: the caller's moment to say how it went.
const emit = defineEmits<{ back: [] }>();
// Whether a gilded button's folded command is showing; a caller binds it to keep one panel open at a time.
const open = defineModel<boolean>(`open`, { default: false });
defineSlots<{
    // Laid out in the button's own row, whichever of the three renderings draws it: the caller's secondary step.
    beside?: () => VNode[];
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

// The loud tier in the house gold (primeng.css); gold stands for moving up a version, so it goes on nothing else.
const GILDED = `ui-button-loud ui-button-gilded`;
// The glyph says where the press goes: up a version, down into the machine, or the older swap's bolt.
const icon = computed<IconName>(() => (props.action === DOWNLOAD ? `download` : props.gilded ? `arrow-circle-up` : `bolt`));
// The button's row, shared with the caller's `beside` step; the gilded one sits a little further from its neighbour.
const row = computed(() => (props.gilded ? `flex flex-wrap items-center gap-x-4 gap-y-2` : `flex flex-wrap items-center gap-2`));

// What this action costs, read by all four renderings: the sandbox stays up through the download and rebuild, and
// only the final restart interrupts anything.
const cost = computed(() => {
    if (props.action === `Download`) {
        return t(`capabilities.hostRecreate.costDownload`);
    }
    // A rebuild downloads nothing — it builds the approved recipe on the image already there.
    if (props.action === `Rebuild`) {
        return t(`capabilities.hostRecreate.costRebuild`);
    }
    // Neither does a rollback: the image it goes back to is already on that machine.
    if (props.action === `Roll back`) {
        return t(`capabilities.hostRecreate.costRollBack`);
    }
    if (props.ready === true) {
        return props.keepsSaid === true ? t(`capabilities.hostRecreate.costRestartOnlyShort`) : t(`capabilities.hostRecreate.costRestartOnly`);
    }
    return props.keepsSaid === true ? t(`capabilities.hostRecreate.costBuildThenRestartShort`) : t(`capabilities.hostRecreate.costBuildThenRestart`);
});

// What the hub row this is rendered on says while the machine works: the same button sits on Environment and on
// Overview's update tile, and each reports where it was pressed.
const workingWords = (): Record<Action, string> => ({
    Download: t(`capabilities.hostRecreate.workingDownload`),
    Update: t(`capabilities.hostRecreate.workingUpdate`),
    Rebuild: t(`capabilities.hostRecreate.workingRebuild`),
    "Roll back": t(`capabilities.hostRecreate.workingRollBack`),
});
const hubWork = useHubWork();

// WHO THE RESTART STOPS, counted when the owner is asked, as DevRebuild and the update card's rollback do: the download
// and the build interrupt nothing, the cutover every turn in flight. A turn a restart killed is recorded rather than
// held, so nothing afterwards can run it again with one press (agent.resume answers NOT_FOUND); instead the owner says so
// here, before the restart, and the sandbox resumes what it cut on its next boot (resumeTurns). A rebuild can also wait
// for them instead: the sandbox holds it until nobody is mid-turn (useRebuildWhenIdle).
const agents = useAgents();
const { fleet } = agents;
const { settings } = useSandboxSettings();
const autoResume = computed(() => settings.value?.autoResumeOnRestart === true);
const activeAgents = computed(() => fleet.value.filter(turnInFlight));
const idle = useRebuildWhenIdle();
// Checked by default: the owner is restarting under agents they set working, and the box is right beside the names.
const resumeAfter = ref(true);
// Offered while someone is mid-turn, the owner's own setting does not already resume them, and the sandbox can.
const offerResume = computed(() => activeAgents.value.length > 0 && !autoResume.value && idle.supported.value && props.action !== DOWNLOAD);
const resumes = computed(() => autoResume.value || (offerResume.value && resumeAfter.value));
const interruption = computed(() => {
    const count = activeAgents.value.length;
    if (count === 0) {
        return undefined;
    }
    const key = resumes.value ? `capabilities.hostRecreate.resumesAgents` : `capabilities.hostRecreate.interruptsAgents`;
    return t(key, { count, names: activeAgents.value.map((agent) => agent.title ?? agent.id).join(`, `) }, count);
});

// Only a rebuild of an approved overlay waits: an update or a rollback is timed by the owner, on its own card.
const offerWait = computed(() => props.action === `Rebuild` && props.hash !== undefined && activeAgents.value.length > 0 && idle.supported.value);
const idleWait = computed(() => (props.action === `Rebuild` ? idle.wait.value : undefined));
const waitForIdle = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    if (id === undefined || props.hash === undefined) {
        return;
    }
    failure.value = undefined;
    done.value = undefined;
    try {
        await idle.ask(id, props.hash);
    } catch (error) {
        failure.value = noticeFrom(error, t(`capabilities.hostRecreate.waitDidntGoThrough`));
    }
};
const stopWaiting = async (): Promise<void> => {
    try {
        await idle.cancel();
    } catch (error) {
        failure.value = noticeFrom(error, t(`capabilities.hostRecreate.waitDidntGoThrough`));
    }
};

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

// What the sandbox going quiet means while this runs, for every surface that isn't this tile. `Download` is absent
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

// FROM THE PRESS UNTIL THE SANDBOX ANSWERS ON WHAT IT WAS SWAPPED ONTO. Every swap run from here is relayed by the
// daemon it replaces, so its stream should die at the cutover; but a relayed stream can stay half-open (one did for
// twelve minutes in WebKitGTK, with "Rebuilding" on screen all along), so its end is not what this waits for. The watch
// is armed at the press and ends at whichever comes first: the device answering in words, the sandbox answering on the
// approved overlay (a rebuild) or on another version (an update, a rollback), or a deadline below, which ends it with
// the words for not knowing.
// A stream that died while the sandbox never went quiet was not the cutover: lost contact, once this runs out.
const CUTOVER_GRACE_MS = 60_000;
// How long the sandbox may stay out of reach once it went quiet; a swap's restart takes about half a minute.
const DOWN_PATIENCE_MS = 3 * 60_000;
// How long it may answer again with the swap not landed and the stream silent. A stream still printing is a swap still
// running (the page's own connection blinked mid-download); a silent one past this will never end.
const BACK_PATIENCE_MS = 3 * 60_000;
// How often an answering sandbox is asked what it runs while the swap has not landed.
const LANDED_POLL_MS = 5_000;

const watching = ref(false);
const severed = ref(false);
const wentDown = ref(false);
// The spinner line is the cutover's, not the build's before it: once the stream has ended or the sandbox gone quiet.
const awaiting = computed(() => watching.value && (severed.value || wentDown.value));
// The version the press was made on, so an update or a rollback is seen landing as another one.
let fromVersion: string | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let settleWatch: (() => void) | undefined;
let asking = false;
// Hands a press's restart to the sandbox's own return (sandboxRestart.ts `untilAnswered`), once: at the press's end while
// the watch still runs, or when the page is left mid-swap.
let handOff: (() => void) | undefined;

// Ends the watch however it ended. The swap's own promise races the watch's, so a stream that never ends lets go here.
const stopWatching = (): void => {
    watching.value = false;
    clearTimeout(deadline);
    clearInterval(poll);
    settleWatch?.();
    settleWatch = undefined;
};

type GiveUp = `capabilities.hostRecreate.lostBeforeRestart` | `capabilities.hostRecreate.returnTimedOut`;
// One deadline at a time, each saying what not knowing means at that point.
const giveUpIn = (ms: number, said: GiveUp): void => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
        if (watching.value) {
            failure.value = { tone: `warning`, title: t(said) };
            stopWatching();
        }
    }, ms);
};

// Whether what answers now is what the swap aimed at. With the starting version unknown, answering again after going
// quiet is the only sign there is.
const hasLanded = async (): Promise<boolean> => {
    if (props.hash !== undefined) {
        return (await appliedHash()) === props.hash;
    }
    return fromVersion === undefined ? wentDown.value : (await runningVersion()) !== fromVersion;
};

const checkLanded = async (): Promise<void> => {
    if (!watching.value || !reachable.value || asking) {
        return;
    }
    asking = true;
    // allow(silent-catch): a sandbox still coming up refuses its reads; that is "not landed yet", and the next poll asks again
    const landed = await hasLanded().catch(() => false);
    asking = false;
    if (!landed || !watching.value) {
        return;
    }
    stopWatching();
    // The log described a container that is gone; how the swap went is the answering sandbox's to say.
    lines.value = [];
    emit(`back`);
    // The open page kept drawing the turns the restart stopped as running: the fleet as the new daemon has it.
    void agents.refresh();
};

const armWatch = (): Promise<undefined> => {
    stopWatching();
    watching.value = true;
    severed.value = false;
    wentDown.value = !reachable.value;
    if (wentDown.value) {
        giveUpIn(DOWN_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
    }
    poll = setInterval(() => void checkLanded(), LANDED_POLL_MS);
    return new Promise((resolve) => {
        settleWatch = () => resolve(undefined);
    });
};

watch(reachable, (up) => {
    if (!watching.value) {
        return;
    }
    if (!up) {
        wentDown.value = true;
        giveUpIn(DOWN_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
        return;
    }
    // Back: landed, or only this page's connection blinked while the swap runs on, which its next line says (heard).
    giveUpIn(BACK_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
    void checkLanded();
});
// Leaving mid-swap is not the swap ending: the container is replaced all the same, so the restart is handed to the
// sandbox's own return before the watch lets go, or every other surface would read the cutover's silence as an outage.
onBeforeUnmount(() => {
    if (watching.value) {
        handOff?.();
        handOff = undefined;
    }
    stopWatching();
});

// A line from the device is the swap still running, so the patience for a sandbox that is back but not landed restarts.
const heard = (line: string): void => {
    lines.value.push(line);
    if (watching.value && wentDown.value && reachable.value) {
        giveUpIn(BACK_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
    }
};

// The version this press is made on, read before the swap can move it; a rebuild is told by its hash instead.
const noteStartingVersion = (swapping: boolean): void => {
    fromVersion = undefined;
    if (!swapping || props.hash !== undefined) {
        return;
    }
    void runningVersion()
        .then((version) => {
            fromVersion = version;
        })
        // allow(silent-catch): unread, the landing is told by the sandbox answering again after going quiet (hasLanded)
        .catch(() => undefined);
};

// The stream died with no answer. A download never touches the container, so that is lost contact like any other; a
// swap's may be the cutover, which the watch armed at the press waits out.
const streamDied = (): void => {
    if (!watching.value) {
        void armWatch();
    }
    severed.value = true;
    if (!wentDown.value) {
        giveUpIn(CUTOVER_GRACE_MS, `capabilities.hostRecreate.lostBeforeRestart`);
    }
};

// What the lines under a waiting button say: the restart this is, and that the page picks it up by itself.
const comingBack = computed(() => t(`capabilities.hostRecreate.comingBack`, { what: QUIET.value[props.action]?.title ?? verb.value }));

// The press's restart as the sandbox's own return holds it, for when it outlives the press; nothing to hand where the
// action restarts nothing or no sandbox is active.
const handOffTo = (sandbox: string | undefined, quiet: RestartQuiet | undefined): (() => void) | undefined => {
    if (sandbox === undefined || quiet === undefined) {
        return undefined;
    }
    const what = workingWords()[props.action];
    return () => {
        expectRestart({ sandbox, id: `recreate`, what, quiet, untilAnswered: true });
    };
};

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
    const swapping = props.action !== DOWNLOAD;
    noteStartingVersion(swapping);
    // Armed for the whole op, not just its restart: the machine gives no sign of which minute the swap falls in, and
    // an expectation costs nothing while the sandbox is still answering.
    const quiet = QUIET.value[props.action];
    const sandbox = activeSandboxId.value;
    const expecting = quiet !== undefined && sandbox !== undefined;
    const working = expecting ? expectRestart({ sandbox, id: `recreate`, what: workingWords()[props.action], quiet }) : undefined;
    handOff = handOffTo(sandbox, quiet);
    // Now, not later: a rebuild the sandbox was holding for idle agents is withdrawn first, or it would run again.
    if (idleWait.value !== undefined && idleWait.value.phase !== `rebuilding`) {
        // allow(silent-catch): a wait that could not be withdrawn is one this rebuild replaces anyway; its restart ends it
        await idle.cancel().catch(() => undefined);
    }
    const payload: DeviceSandboxPayload = { ...(props.hash === undefined ? {} : { hash: props.hash }), onLine: heard };
    if (offerResume.value && resumeAfter.value) {
        payload.resumeTurns = true;
    }
    const watched = swapping ? armWatch() : undefined;
    const endWork = hubWork.begin(workingWords()[props.action]);
    try {
        const stream = swapping
            ? swapServingSandbox(id, props.slug, OP[props.action], payload)
            : manageDeviceSandbox(id, props.slug, OP[props.action], payload);
        const said = await (watched === undefined ? stream : Promise.race([stream, watched]));
        if (said !== undefined) {
            // The device answered in words: nothing was swapped out from under this page, or it says why not.
            done.value = said;
            stopWatching();
        } else if (!swapping || watching.value) {
            streamDied();
        }
    } catch (error) {
        failure.value = noticeFrom(error, t(`capabilities.hostRecreate.didntGoThrough`, { action: verb.value }));
        stopWatching();
    } finally {
        running.value = false;
        endWork();
        working?.();
        // Handed to the sandbox's own return: this page cannot see the container come up, and the ledger's record is
        // what every other surface reads the silence by until it does.
        if (watching.value) {
            handOff?.();
        }
        handOff = undefined;
    }
};

// The record a rebuild the sandbox started by itself holds, for as long as this page watches it.
let idleClaim: (() => void) | undefined;

// The sandbox started the rebuild it was holding: this page watches for it to land exactly as it does for its own
// press, and every other surface reads the silence to come as that restart.
watch(
    () => idleWait.value?.phase,
    (phase) => {
        if (phase !== `rebuilding`) {
            // Over without this page seeing the sandbox go quiet: the device refused it, failed, or answered in words.
            // Nothing restarted, so the watch and its record end here rather than polling on and naming a restart
            // everywhere until the next reconnect. A restart that did happen goes quiet first, which the watch sees.
            if (idleClaim !== undefined && watching.value && !running.value && !wentDown.value) {
                idleClaim();
                idleClaim = undefined;
                stopWatching();
            }
            return;
        }
        const sandbox = activeSandboxId.value;
        const quiet = QUIET.value.Rebuild;
        if (watching.value || running.value || sandbox === undefined || quiet === undefined) {
            return;
        }
        void armWatch();
        idleClaim = expectRestart({ sandbox, id: `recreate`, what: workingWords().Rebuild, quiet, untilAnswered: true });
    },
    { immediate: true },
);

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
    <div :class="gilded ? `flex flex-col gap-3` : bare ? undefined : `flex flex-col gap-2`">
        <!-- Machine is reachable from here, so this is a button wherever you're reading it, even a phone elsewhere. -->
        <template v-if="hostId">
            <div :class="row">
                <Button
                    :label="running ? t(`capabilities.hostRecreate.running`, { action: verb }) : (label ?? t(`capabilities.hostRecreate.now`, { action: verb }))"
                    :size="gilded ? undefined : `small`"
                    :class="gilded ? GILDED : undefined"
                    :severity="!gilded && (text || action === DOWNLOAD) ? `secondary` : undefined"
                    :text="text"
                    :loading="running || awaiting || idleWait?.phase === `rebuilding`"
                    @click="runOnMachine"
                >
                    <template v-if="!text" #icon><Icon :name="icon" /></template>
                </Button>
                <slot name="beside" />
            </div>
            <p v-if="!bare && !gilded" class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.runsOnDeviceHosting`, { cost }) }}</p>
            <DeviceRunLog
                v-if="running || lines.length > 0"
                :lines="lines"
                :running="running"
                :empty="t(`capabilities.hostRecreate.startingOnDevice`)"
                :note="t(`capabilities.hostRecreate.runningOnDeviceKeeps`)"
            />
            <!-- The cutover, said as the restart it is rather than as the connection it cost. -->
            <p v-if="awaiting" class="flex items-center gap-1.5 text-2xs text-muted" role="status">
                <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />{{ comingBack }}
            </p>
            <Notice v-else-if="failure" :of="failure" />
            <p v-else-if="done" class="text-2xs text-muted">{{ done }}</p>

            <!-- A rebuild the sandbox holds until nobody is working: who it waits on, and the way out. The button above
                 stays, as the way to rebuild now instead. -->
            <div v-if="idleWait?.phase === `waiting`" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted" role="status">
                <Icon name="clock" class="shrink-0" aria-hidden="true" />
                <span>{{
                    idleWait.waitingOn.length > 0
                        ? t(`capabilities.hostRecreate.waitingForAgents`, { names: idleWait.waitingOn.join(`, `) }, idleWait.waitingOn.length)
                        : t(`capabilities.hostRecreate.startingOnceIdle`)
                }}</span>
                <Button :label="t(`capabilities.hostRecreate.stopWaiting`)" size="small" severity="secondary" :text="true" @click="stopWaiting" />
            </div>
            <p v-else-if="idleWait?.phase === `rebuilding` && !awaiting" class="flex items-center gap-1.5 text-2xs text-muted" role="status">
                <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />{{ t(`capabilities.hostRecreate.rebuildingNowIdle`) }}
            </p>
            <div v-else-if="idleWait?.phase === `failed`" class="flex flex-col gap-1">
                <Notice :of="{ tone: `warning`, title: t(`capabilities.hostRecreate.idleRebuildFailed`), detail: idleWait.message }" />
                <Button :label="t(`ui.action.dismiss`)" size="small" severity="secondary" :text="true" class="self-start" @click="stopWaiting" />
            </div>

            <!-- Not destructive: every action here keeps the sandbox's files and just moves it to another image. -->
            <ConfirmDialog
                :open="confirming"
                :header="confirmHeader"
                :confirm-label="t(`capabilities.hostRecreate.now`, { action: verb })"
                :confirm-icon="icon"
                :header-icon="gilded ? `sparkles` : undefined"
                :destructive="false"
                :gilded="gilded"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <p>{{ confirmBody }}</p>
                <p v-if="interruption" class="mt-3 text-xs text-warning">{{ interruption }}</p>
                <!-- Said before the restart, since afterwards nothing can run a cut turn again with one press. -->
                <label v-if="offerResume" class="mt-2 flex items-center gap-2 text-xs text-content">
                    <Checkbox v-model="resumeAfter" binary size="small" />
                    {{ t(`capabilities.hostRecreate.continueAfter`, {}, activeAgents.length) }}
                </label>
                <p class="mt-3 text-xs text-muted">
                    {{ t(`capabilities.hostRecreate.onlySandboxRestartsNothing`) }}
                </p>
                <template v-if="offerWait" #actions>
                    <Button :label="t(`capabilities.hostRecreate.whenIdle`, {}, activeAgents.length)" severity="secondary" :text="true" @click="waitForIdle">
                        <template #icon><Icon name="clock" /></template>
                    </Button>
                </template>
            </ConfirmDialog>
        </template>

        <!-- Desktop deep link covers all three swaps including rollback. -->
        <template v-else-if="desktop && action !== DOWNLOAD">
            <div :class="row">
                <Button
                    :label="label ?? t(`capabilities.hostRecreate.now`, { action: verb })"
                    :size="gilded ? undefined : `small`"
                    :class="gilded ? GILDED : undefined"
                    @click="openDesktopLink(desktopRecreateLink(slug, hash, action === `Roll back`))"
                >
                    <template #icon><Icon :name="icon" /></template>
                </Button>
                <slot name="beside" />
            </div>
            <p v-if="!bare && !gilded" class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.runsHereOnDevice`, { cost }) }}</p>
        </template>

        <template v-else>
            <!-- Gilded, the button still leads and the command is the step it opens: what to run is for whoever is
                 about to run it, not a block of shell at the top of the page for everyone who opens it. -->
            <div v-if="gilded" :class="row">
                <Button
                    :label="label ?? t(`capabilities.hostRecreate.now`, { action: verb })"
                    :class="GILDED"
                    :aria-expanded="open"
                    @click="open = !open"
                >
                    <template #icon><Icon :name="icon" /></template>
                </Button>
                <slot name="beside" />
            </div>
            <div
                v-if="!gilded || open"
                :class="gilded ? `flex flex-col gap-2.5 rounded-lg border border-line-subtle bg-canvas/50 p-3.5` : `flex flex-col gap-2`"
            >
                <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <p class="text-xs text-content">{{ t(`capabilities.hostRecreate.runInTerminal`) }}</p>
                    <SegmentedControl
                        v-model="cmdOs"
                        size="xs"
                        :options="[
                            { label: `Linux / macOS`, value: `unix` },
                            { label: `Windows`, value: `windows` },
                        ]"
                    />
                </div>
                <Code :code="command" :lang="commandLang(cmdOs)" :wrap="true" />
                <p v-if="!gilded" class="text-2xs text-subtle">{{ cost }}</p>
                <!-- The cheaper way out where it exists: the machine is already talking to this sandbox, and one tile turns that into the button above. -->
                <ConnectDeviceHint :slug="slug" :gains="t(`capabilities.hostRecreate.becomesButtonHere`, { action: verb })" />
                <!-- Offered here, not just at setup, since this is the moment reaching for the app repeatedly starts to pay off. -->
                <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-subtle">
                    <span>{{ t(`capabilities.hostRecreate.skipTerminalNextTime`) }}</span>
                    <a :href="DESKTOP_DOWNLOADS.windows" class="text-link hover:underline">{{ t(`capabilities.hostRecreate.intenticWindows`) }}</a>
                    <span>·</span>
                    <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="text-link hover:underline">Linux</a>
                    <span>{{ t(`capabilities.hostRecreate.doesButton`) }}</span>
                </p>
            </div>
        </template>
    </div>
</template>
