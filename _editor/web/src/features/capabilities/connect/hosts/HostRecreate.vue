<script setup lang="ts">
import type { DeviceSandboxOp } from "@intentic/sandbox-contract";
import {
    Button,
    ui,
    ConfirmDialog,
    DeviceRunLog,
    type IconName,
    Notice,
    type NoticeModel,
    type CommandOs,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import { computed, onBeforeUnmount, ref, shallowRef, type VNode, watch } from "vue";
import { type DeviceSandboxPayload, swapServingSandbox, useHostRunning } from "../../../sandbox/devices/useDevices";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { expectRestart, type RestartQuiet } from "../../../sandbox/live/sandboxRestart";
import { useOperation } from "../../../../workbench/operations/operations";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandboxSettings } from "../../../sandbox/overview/useSandboxSettings";
import { appliedHash, runningVersion } from "./swapLanding";
import { followSwap, type SwapEnd, SwapGaveUp, type SwapProgress } from "./swapFollow";
import { useRebuildWhenIdle } from "./useRebuildWhenIdle";
import ConnectDeviceHint from "../../../sandbox/devices/ConnectDeviceHint.vue";
import { desktopRecreateLink, desktopVersion, openDesktopLink } from "../../../../app/environments/desktop";
import { DESKTOP_DOWNLOADS } from "../../../../app/environments/desktopDownloads";
import { bashCommand, oneLiner, psCommand } from "../../../../app/environments/scriptCommand";
import RunCommand from "../../../../components/RunCommand.vue";
import { oneLinerFits } from "@intentic/constants";
import { useT } from "@intentic/ui/i18n";

// Recreating needs the host machine (the daemon has no host Docker socket for its own container), so this renders
// across four surfaces: a button on a connected device or the desktop app, else a copyable per-OS command. Mode
// rides the argument shape (a hash rebuilds that pinned overlay, no hash pulls :stable), not a flag. Downloading an
// update ahead of its restart is not a button here: the machine does it by itself (the update card's
// useBackgroundDownload, and the machine agent's timer).
//
// Every caller hands it the slug of the sandbox serving this page (read off its own /environment), so every swap run
// from here is relayed by the very daemon it replaces: the stream dies at the cutover. That is the swap happening, not
// contact lost, so the button waits for the sandbox to come back and then gets out of the way; what the swap did is
// read off the sandbox that answered (the update card's `lastUpdate`).

const t = useT();

type Action = `Update` | `Rebuild` | `Roll back`;

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

const { activeSandboxId, reachable } = useSandbox();
const desktop = computed(() => desktopVersion() !== undefined);

// The machine, when it is one this sandbox can ask directly.
const hostId = useHostRunning(() => props.slug);
const OP: Record<Action, DeviceSandboxOp> = { Update: `update`, Rebuild: `rebuild`, "Roll back": `rollback` };

// The action as a reader sees it. `Action` is the enum this component switches on and the script it runs, so its
// members are not the words on screen: every label takes this instead.
const VERBS: Record<Action, string> = { Update: `update`, Rebuild: `rebuild`, "Roll back": `rollBack` };
const verbOf = (action: Action): string => t(`capabilities.hostRecreate.${VERBS[action]}Verb` as `capabilities.hostRecreate.updateVerb`);
const verb = computed(() => verbOf(props.action));

// The loud tier in the house gold (primeng.css); gold stands for moving up a version, so it goes on nothing else.
// The glyph says where the press goes: up a version, or the older swap's bolt.
const icon = computed<IconName>(() => (props.gilded ? `arrow-circle-up` : `bolt`));
// The button's row, shared with the caller's `beside` step; the gilded one sits a little further from its neighbour.
const row = computed(() => (props.gilded ? `flex flex-wrap items-center gap-x-4 gap-y-2` : `flex flex-wrap items-center gap-2`));

// What this action costs, read by all four renderings: the sandbox stays up through the download and rebuild, and
// only the final restart interrupts anything.
const cost = computed(() => {
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

// What the hub row and the receipt say while the machine works: the same button sits on Environment and on Overview's
// update tile, and each reports where it was pressed.
const workingWords = (): Record<Action, string> => ({
    Update: t(`capabilities.hostRecreate.workingUpdate`),
    Rebuild: t(`capabilities.hostRecreate.workingRebuild`),
    "Roll back": t(`capabilities.hostRecreate.workingRollBack`),
});
const isAction = (tag: string | undefined): tag is Action => tag !== undefined && Object.hasOwn(OP, tag);

// THE SWAP IS THE SANDBOX'S, NOT THIS BUTTON'S. Environment's Rebuild, the update card's Update and the version panel's
// Roll back all replace the one container serving this page, so they share one run: pressed on any of them, it is read
// on all three and holds all three buttons. Its log, where it stands (still building, or waiting out the cutover) and
// how it ended live in the operations ledger, so a reader who leaves mid-build comes back to it still running, and one
// who comes back after it ended finds how it went.
const swap = useOperation<SwapEnd, NoticeModel, SwapProgress>(() => `sandbox/${props.slug}/swap`);
const busy = swap.busy;
// Which of the three is running, by the run's own word: an update pressed on Overview reads as an update here too.
const runningAction = computed<Action>(() => {
    const tag = swap.operation.value?.tag;
    return busy.value && isAction(tag) ? tag : props.action;
});
// The device's stream is still being read: the download and build before the cutover, which the button names.
const streaming = computed(() => busy.value && swap.progress.value?.streaming === true);
// The device answered in words: nothing was swapped out from under this page, or it says why not.
const done = computed(() => {
    const end = swap.value.value;
    return end !== undefined && `said` in end ? end.said : undefined;
});
// Landed: the log described a container that is gone, and how the swap went is the answering sandbox's to say.
const landed = computed(() => {
    const end = swap.value.value;
    return end !== undefined && `landed` in end;
});
const lines = computed(() => (landed.value ? [] : swap.lines.value));
// The sandbox answered on what a swap aimed at while this card is open: the caller's moment to say how it went.
watch(landed, (now) => {
    if (now) {
        emit(`back`);
    }
});

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
const offerResume = computed(() => activeAgents.value.length > 0 && !autoResume.value && idle.supported.value);
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
// Asking the sandbox to hold a rebuild, or withdrawing it. The wait itself is the sandbox's and reads back off
// /environment; a refusal is kept beside the swap's own, so the card that comes back still says it.
const whenIdle = useOperation(() => `sandbox/${props.slug}/swap-when-idle`);
const changeWhen = (task: () => Promise<void>): Promise<unknown> =>
    whenIdle.run({
        what: t(`capabilities.hostRecreate.changingWhen`),
        failed: t(`capabilities.hostRecreate.waitDidntGoThrough`),
        // The wait line under the button says how it went.
        quiet: true,
        task,
    });
const waitForIdle = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    const hash = props.hash;
    if (id === undefined || hash === undefined) {
        return;
    }
    swap.dismiss();
    idleFailure.value = undefined;
    await changeWhen(() => idle.ask(id, hash));
};
const stopWaiting = async (): Promise<void> => {
    await changeWhen(() => idle.cancel());
};

// Recreating always drops this page's connection, confirmed in-app (not the browser's confirm()) before it starts.
const confirming = ref(false);

const runOnMachine = (): void => {
    if (hostId.value === undefined || busy.value) {
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

// What the sandbox going quiet means while this runs, for every surface that isn't this tile.
const QUIET = computed((): Record<Action, RestartQuiet> => ({
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

// Whether what answers now is what the swap aimed at: a rebuild by its overlay, an update or a rollback by moving off
// the version it was pressed on. With that version unread, answering again after going quiet is the only sign there is.
const landedOn = async (hash: string | undefined, from: string | undefined, now: SwapProgress): Promise<boolean> => {
    if (hash !== undefined) {
        return (await appliedHash()) === hash;
    }
    return from === undefined ? now.wentDown : (await runningVersion()) !== from;
};

// A REBUILD THE SANDBOX STARTED BY ITSELF once its agents were idle. Nobody pressed anything here and the sandbox reports
// it (`rebuilding` on /environment, read again on every mount), so it is followed for as long as this card is open,
// exactly as a press's swap is, with its restart handed to the sandbox's own return so every other surface reads the
// silence to come by it.
const idleFollow = shallowRef<SwapProgress>();
const idleFailure = ref<NoticeModel>();
let stopIdleFollow: (() => void) | undefined;
// The record that follow holds; untilAnswered, so the sandbox coming back ends it wherever the reader is by then.
let idleClaim: (() => void) | undefined;
const letIdleGo = (): void => {
    stopIdleFollow?.();
    stopIdleFollow = undefined;
    idleFollow.value = undefined;
};
onBeforeUnmount(letIdleGo);

// The spinner line is the cutover's, not the build's before it: once the stream has ended or the sandbox gone quiet.
const awaiting = computed(() => {
    const now = busy.value ? swap.progress.value : idleFollow.value;
    return now !== undefined && (now.severed || now.wentDown);
});
const failure = computed(() => swap.failure.value ?? whenIdle.failure.value ?? idleFailure.value);

// What the lines under a waiting button say: the restart this is, and that the page picks it up by itself.
const comingBack = computed(() => t(`capabilities.hostRecreate.comingBack`, { what: QUIET.value[runningAction.value].title }));

const execute = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    if (id === undefined || busy.value) {
        return;
    }
    // Read at the press: the run outlives this card, and its props with it.
    const { action, hash, slug } = props;
    const sandbox = activeSandboxId.value;
    const what = workingWords()[action];
    const quiet = QUIET.value[action];
    const didnt = t(`capabilities.hostRecreate.didntGoThrough`, { action: verbOf(action) });
    const resumeTurns = offerResume.value && resumeAfter.value;
    // Now, not later: a rebuild the sandbox was holding for idle agents is withdrawn first, or it would run again.
    const withdraw = idleWait.value !== undefined && idleWait.value.phase !== `rebuilding`;
    // A rebuild the sandbox started by itself is this press's to follow from here.
    letIdleGo();
    idleClaim?.();
    idleClaim = undefined;
    idleFailure.value = undefined;
    whenIdle.dismiss();
    await swap.run({
        what,
        tag: action,
        progress: { streaming: true, severed: false, wentDown: false },
        failed: (error) => (error instanceof SwapGaveUp ? { tone: `warning`, title: error.message } : noticeFrom(error, didnt)),
        // The device's own words when it answered; a swap that landed is said in the hub row's words.
        done: (end) => (`said` in end ? end.said : undefined),
        task: async (report) => {
            // The version this press is made on, read before the swap can move it; a rebuild is told by its hash instead.
            let from: string | undefined;
            if (hash === undefined) {
                void runningVersion()
                    .then((version) => {
                        from = version;
                    })
                    // allow(silent-catch): unread, the landing is told by the sandbox answering again after going quiet (landedOn)
                    .catch(() => undefined);
            }
            const follow = followSwap({
                reachable: () => reachable.value,
                here: () => activeSandboxId.value === sandbox,
                landed: (now) => landedOn(hash, from, now),
                streaming: true,
                progress: report.progress,
            });
            // Armed for the whole op, not just its restart: the machine gives no sign of which minute the swap falls in,
            // and an expectation costs nothing while the sandbox is still answering.
            const working = sandbox === undefined ? undefined : expectRestart({ sandbox, id: `recreate`, what, quiet });
            try {
                if (withdraw) {
                    // allow(silent-catch): a wait that could not be withdrawn is one this rebuild replaces anyway; its restart ends it
                    await idle.cancel().catch(() => undefined);
                }
                const payload: DeviceSandboxPayload = {
                    ...(hash === undefined ? {} : { hash }),
                    onLine: (line) => {
                        report.line(line);
                        follow.heard();
                    },
                };
                if (resumeTurns) {
                    payload.resumeTurns = true;
                }
                // The swap's own promise races the follow's, so a stream that never ends lets go once the swap has landed.
                const first = await Promise.race([
                    swapServingSandbox(id, slug, OP[action], payload).then((said): SwapEnd | undefined => (said === undefined ? undefined : { said })),
                    follow.landed.then((): SwapEnd => ({ landed: true })),
                ]);
                if (first !== undefined && `said` in first) {
                    return first;
                }
                if (first === undefined) {
                    // The stream died with no answer, which may be the cutover. Handed to the sandbox's own return: nothing
                    // here sees the container come up, and that record is what every other surface reads the silence by
                    // until it does.
                    working?.();
                    if (sandbox !== undefined) {
                        expectRestart({ sandbox, id: `recreate`, what, quiet, untilAnswered: true });
                    }
                    follow.streamDied();
                    await follow.landed;
                }
                // The open page kept drawing the turns the restart stopped as running: the fleet as the new daemon has it.
                void agents.refresh();
                return { landed: true };
            } finally {
                follow.stop();
                working?.();
            }
        },
    });
};

// The sandbox started the rebuild it was holding: followed here exactly as a press's swap is.
watch(
    () => idleWait.value?.phase,
    (phase) => {
        if (phase !== `rebuilding`) {
            // Over without this page seeing the sandbox go quiet: the device refused it, failed, or answered in words.
            // Nothing restarted, so the follow and its record end here rather than polling on and naming a restart
            // everywhere until the next reconnect. A restart that did happen goes quiet first, which the follow sees.
            if (idleClaim !== undefined && idleFollow.value !== undefined && !idleFollow.value.wentDown) {
                idleClaim();
                idleClaim = undefined;
                letIdleGo();
            }
            return;
        }
        const sandbox = activeSandboxId.value;
        if (idleFollow.value !== undefined || busy.value || sandbox === undefined) {
            return;
        }
        const hash = props.hash;
        const follow = followSwap({
            reachable: () => reachable.value,
            here: () => activeSandboxId.value === sandbox,
            landed: (now) => landedOn(hash, undefined, now),
            streaming: false,
            progress: (now) => {
                idleFollow.value = now;
            },
        });
        stopIdleFollow = follow.stop;
        follow.landed.then(
            () => {
                letIdleGo();
                emit(`back`);
                void agents.refresh();
            },
            (error: unknown) => {
                letIdleGo();
                idleFailure.value = { tone: `warning`, title: error instanceof Error ? error.message : String(error) };
            },
        );
        idleClaim = expectRestart({ sandbox, id: `recreate`, what: workingWords().Rebuild, quiet: QUIET.value.Rebuild, untilAnswered: true });
    },
    { immediate: true },
);

// One verb per mode, each the same recreate script underneath: rollback, rebuild onto a hash, or update. An argument no
// one-liner can carry (an odd hash) keeps the script's older spelling.
const command = (os: CommandOs): string => {
    const rollback = props.action === `Roll back`;
    const [route, args] = rollback
        ? ([`rollback`, [props.slug]] as const)
        : props.hash === undefined
          ? ([`update`, [props.slug]] as const)
          : ([`rebuild`, [props.slug, props.hash]] as const);
    if (oneLinerFits(route, args)) {
        return oneLiner(route, args, os);
    }
    const key = props.hash === undefined ? `update` : `rebuild`;
    if (os === `windows`) {
        const flags = rollback ? `-Slug ${props.slug} -Rollback` : props.hash === undefined ? `-Slug ${props.slug}` : `-Slug ${props.slug} -Hash ${props.hash}`;
        return psCommand(props.hash === undefined ? `updatePs1` : `rebuildPs1`, ``, flags);
    }
    return bashCommand(key, ``, rollback ? `${props.slug} --rollback` : props.hash === undefined ? props.slug : `${props.slug} ${props.hash}`);
};</script>

<template>
    <div :class="gilded ? `flex flex-col gap-3` : bare ? undefined : `flex flex-col gap-2`">
        <!-- Machine is reachable from here, so this is a button wherever you're reading it, even a phone elsewhere. -->
        <template v-if="hostId">
            <div :class="row">
                <Button
                    :label="
                        streaming
                            ? t(`capabilities.hostRecreate.running`, { action: verbOf(runningAction) })
                            : (label ?? t(`capabilities.hostRecreate.now`, { action: verb }))
                    "
                    :size="gilded ? undefined : `small`"
                    :tier="gilded ? `loud` : text ? `quiet` : `accent`"
                    :gilded="gilded"
                    :loading="busy || awaiting || idleWait?.phase === `rebuilding`"
                    @click="runOnMachine"
                >
                    <template v-if="!text" #icon><Icon :name="icon" /></template>
                </Button>
                <slot name="beside" />
            </div>
            <p v-if="!bare && !gilded" class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.runsOnDeviceHosting`, { cost }) }}</p>
            <DeviceRunLog
                v-if="streaming || lines.length > 0"
                :lines="lines"
                :running="streaming"
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
                <Button :label="t(`capabilities.hostRecreate.stopWaiting`)" size="small" tier="quiet" @click="stopWaiting" />
            </div>
            <p v-else-if="idleWait?.phase === `rebuilding` && !awaiting" class="flex items-center gap-1.5 text-2xs text-muted" role="status">
                <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />{{ t(`capabilities.hostRecreate.rebuildingNowIdle`) }}
            </p>
            <div v-else-if="idleWait?.phase === `failed`" class="flex flex-col gap-1">
                <Notice :of="{ tone: `warning`, title: t(`capabilities.hostRecreate.idleRebuildFailed`), detail: idleWait.message }" />
                <Button :label="t(`ui.action.dismiss`)" size="small" tier="quiet" class="self-start" @click="stopWaiting" />
            </div>

            <!-- Not destructive: every action here keeps the sandbox's files and just moves it to another image. -->
            <ConfirmDialog
                :open="confirming"
                :header="confirmHeader"
                :confirm-label="t(`capabilities.hostRecreate.now`, { action: verb })"
                :confirm-icon="icon"
                :header-icon="gilded ? `sparkles` : undefined"
                :description="confirmBody"
                :destructive="false"
                :gilded="gilded"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <div class="flex flex-col gap-3">
                    <p v-if="interruption" class="text-xs text-warning">{{ interruption }}</p>
                    <!-- Said before the restart, since afterwards nothing can run a cut turn again with one press. -->
                    <label v-if="offerResume" class="flex items-center gap-2 text-xs text-content">
                        <Checkbox v-model="resumeAfter" binary size="small" />
                        {{ t(`capabilities.hostRecreate.continueAfter`, {}, activeAgents.length) }}
                    </label>
                    <p class="text-xs text-muted">
                        {{ t(`capabilities.hostRecreate.onlySandboxRestartsNothing`) }}
                    </p>
                </div>
                <template v-if="offerWait" #actions>
                    <Button :label="t(`capabilities.hostRecreate.whenIdle`, {}, activeAgents.length)" tier="boring" @click="waitForIdle">
                        <template #icon><Icon name="clock" /></template>
                    </Button>
                </template>
            </ConfirmDialog>
        </template>

        <!-- Desktop deep link covers all three swaps including rollback. -->
        <template v-else-if="desktop">
            <div :class="row">
                <Button
                    :label="label ?? t(`capabilities.hostRecreate.now`, { action: verb })"
                    :size="gilded ? undefined : `small`"
                    :tier="gilded ? `loud` : `accent`"
                    :gilded="gilded"
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
                    tier="loud"
                    gilded
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
                <RunCommand :command="command" :explanation="t(`capabilities.hostRecreate.runInTerminal`)" />
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
