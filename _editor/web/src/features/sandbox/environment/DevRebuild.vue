<script setup lang="ts">
import { devRebuildLogPath } from "@intentic/sandbox-contract";
import { AnchoredOverlay, Button, Code, commandLang, ConfirmDialog, DeviceRunLog, Notice, type NoticeModel, ui } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import ConnectDeviceHint from "../devices/ConnectDeviceHint.vue";
import { turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { useSandboxSettings } from "../overview/useSandboxSettings";
import { useHostHolding } from "../devices/useDevices";
import { type DevRebuildPhase, rebuildElapsedLabel, rebuildRunning, useDevRebuild } from "./useDevRebuild";

// Rebuilding a sandbox whose base was compiled from a checkout, from that checkout. Not HostRecreate's flow: that one
// swaps between images that already exist, and the image this asks for — the working tree as it is now — is not one of
// them until something builds it. A button where the machine is reachable, the command to paste where it isn't; the
// checkout's path is the sandbox's own record of where it came from, never a guess.
//
// It rides the named-command door (`dev-rebuild`, beside `dev-reload`) rather than a machine-side sandbox op, and that
// is the load-bearing choice: the closed set of commands lives in the DAEMON and what crosses to the machine is a line
// for `run_command`, a tool every released agent already has. A new op would instead have to reach a machine whose
// agent is usually older than the sandbox asking — which is every dogfooding machine, and is what made the first
// attempt answer "Input validation failed".
//
// Nothing streams back from the build itself, for the same reason: it is detached out there, and the swap at the end
// replaces the daemon that would have carried a stream. So progress is READ rather than received — useDevRebuild polls
// the machine's own log — and the run it draws lives outside this component, because the build outlives it.

const props = defineProps<{
    slug: string;
    // The locally-built base, named on screen so "built from your checkout" is a fact the reader can check.
    base: string;
    // Host path of that checkout; absent on a sandbox handed a local image without one, which leaves only the command.
    root?: string | undefined;
}>();

// The door that can reach `root`, not merely one that reports the container: a PC answers through its Windows side
// and the distro on it alike, and the build is a `sh` line in a folder only one of them has. The distro's own door
// runs it directly, the Windows door crosses into the distro (the daemon sends the crossing with the command), and
// only a machine with no way to that folder at all falls through to the command below.
const hostId = useHostHolding(
    () => props.slug,
    () => props.root,
);
const { run, elapsed, start, adopt, dismiss } = useDevRebuild(props.slug);

// The card is drawn from the machine's log, not from having clicked the button: a rebuild started in a terminal, in
// another tab, or by this tab before the restart wiped it all land here the same way.
watch(
    hostId,
    (id) => {
        if (id !== undefined) {
            adopt(id);
        }
    },
    { immediate: true },
);

const confirming = ref(false);
const overlayOpen = ref(false);
const anchorRef = ref<HTMLElement>();

const live = computed(() => rebuildRunning(run.phase));

// The two costs, side by side: the build interrupts nothing, the swap at the end of it is the restart.
const cost = `Builds the image while you keep working (may take minutes), then restarts (~30s). /work is kept.`;

const command = computed(() =>
    props.root === undefined ? `pnpm rebuild:sandbox ${props.slug}` : `cd ${props.root} && pnpm rebuild:sandbox ${props.slug}`,
);

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 150;
let timer: ReturnType<typeof setTimeout> | undefined;

const settle = (open: boolean, delay: number): void => {
    clearTimeout(timer);
    if (delay === 0) {
        overlayOpen.value = open;
        return;
    }
    timer = setTimeout(() => {
        overlayOpen.value = open;
    }, delay);
};

const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        settle(true, OPEN_DELAY_MS);
    }
};
const onLeave = (): void => settle(false, CLOSE_DELAY_MS);
const onCardEnter = (): void => clearTimeout(timer);
const onFocus = (): void => settle(true, 0);
const onBlur = (): void => settle(false, 0);

const onButtonClick = (): void => {
    settle(false, 0);
    confirming.value = true;
};

onBeforeUnmount(() => clearTimeout(timer));

// Where the detached build writes, named by the contract that also builds both command lines from it, so the path a
// reader is sent to is the path something actually writes.
const logPath = computed(() => devRebuildLogPath(props.slug));

const execute = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    if (id !== undefined && !live.value) {
        await start(id);
    }
};

const elapsedLabel = computed(() => rebuildElapsedLabel(elapsed.value));

// Each phase says what is happening to the SANDBOX, since that is what the reader is waiting on — not what the device
// is doing, and not what this page is doing about it.
const PROGRESS: Partial<Record<DevRebuildPhase, string>> = {
    starting: `Starting the build on that device…`,
    building: `Building the image from your checkout. Your sandbox keeps working, and restarts on its own once it's built.`,
    restarting: `Restarting your sandbox on the new image. This page reconnects on its own.`,
};
const progress = computed(() => PROGRESS[run.phase]);

const done = computed(() =>
    run.phase === `done` ? `Rebuilt from your checkout in ${elapsedLabel.value ?? `a few minutes`}. You're running the new image.` : undefined,
);

const failure = computed<NoticeModel | undefined>(() => {
    if (run.phase === `failed`) {
        const title = run.exitCode === undefined ? `That device didn't run the rebuild.` : `The rebuild failed on that device (exit ${run.exitCode}).`;
        return { tone: `warning`, title, ...(run.trouble === undefined ? {} : { detail: run.trouble }) };
    }
    if (run.phase === `lost`) {
        return {
            tone: `warning`,
            title: `That rebuild stopped reporting, and never said how it ended.`,
            detail: run.trouble ?? `Nothing has been written to its log for a while: the machine may have slept, or the build was stopped.`,
        };
    }
    return undefined;
});

// A docker layer builds for minutes without printing anything, so a still pane is not evidence of a stuck build — but
// after a while it is worth saying which of the two this is, rather than leaving the reader to guess.
const QUIET_AFTER_S = 90;
const quiet = computed(() => {
    const seconds = run.quietFor ?? 0;
    return run.phase === `building` && seconds > QUIET_AFTER_S
        ? `Nothing new in the log for ${Math.round(seconds / 60)}m — a single docker layer can take that long.`
        : undefined;
});

// A read that failed while the build carries on regardless: the machine's own words, not a verdict on the rebuild.
const hiccup = computed(() => (live.value ? run.trouble : undefined));

// WHAT THE RESTART WILL COST, COUNTED AT THE MOMENT OF ASKING. The build itself interrupts nothing, so the number
// that matters is read now rather than when the swap lands — by then it is a surprise instead of a decision, and
// waiting for the fleet to settle is free while nothing has started.
const { fleet } = useAgents();
const midTurn = computed(() => fleet.value.filter(turnInFlight).length);
const { settings } = useSandboxSettings();
const autoResume = computed(() => settings.value?.autoResumeOnRestart === true);
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- The machine holding the checkout is reachable from here, so this is a button wherever you're reading it. -->
        <template v-if="hostId && root">
            <div
                ref="anchorRef"
                class="inline-flex self-start"
                @pointerenter="onEnter"
                @pointerleave="onLeave"
                @focusin="onFocus"
                @focusout="onBlur"
            >
                <Button
                    :label="live ? `Rebuilding…` : `Rebuild from checkout`"
                    size="small"
                    :loading="live"
                    :disabled="live"
                    @click="onButtonClick"
                >
                    <template #icon><Icon name="bolt" /></template>
                </Button>
            </div>

            <AnchoredOverlay v-model="overlayOpen" :anchor="anchorRef" side="right" cross="start">
                <div
                    class="flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2.5 p-3 text-left"
                    @pointerenter="onCardEnter"
                    @pointerleave="onLeave"
                >
                    <p class="text-2xs text-muted">
                        Runs <span class="font-mono text-content">{{ base }}</span> from your checkout, not a published release. Rebuild to pick up code you've written since.
                    </p>

                    <div class="flex flex-col gap-1">
                        <div class="flex items-baseline justify-between gap-2">
                            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Host command</span>
                            <span class="truncate font-mono text-2xs text-subtle">{{ root }}</span>
                        </div>
                        <Code :code="command" :lang="commandLang(`unix`)" :wrap="true" />
                    </div>

                    <p class="text-2xs leading-relaxed text-subtle">{{ cost }}</p>
                </div>
            </AnchoredOverlay>

            <!-- Detached builds expose device progress and logs. -->
            <div v-if="progress" class="flex items-center gap-2 text-2xs text-muted">
                <Icon name="refresh" spin />
                <span>{{ progress }}</span>
                <span v-if="elapsedLabel" class="ml-auto shrink-0 font-mono tabular-nums text-subtle">{{ elapsedLabel }}</span>
            </div>

            <!-- The log appears before its first line so running is distinct from no activity. -->
            <!-- No note under the pane: the progress line above it is this run's one spinner, and that the build
                 outlives this page is said by the hub's Environment row, where leaving it can be seen. -->
            <DeviceRunLog v-if="live || run.lines.length > 0" :lines="run.lines" :running="live" empty="Waiting for the first line from that device…" />

            <p v-if="quiet" class="text-2xs text-subtle">{{ quiet }}</p>
            <p v-if="hiccup" class="text-2xs text-subtle">Can't read the log at the moment — the build itself is unaffected. {{ hiccup }}</p>

            <Notice v-if="failure" :of="failure" />
            <p v-else-if="done" class="flex items-center gap-2 text-2xs text-muted">
                <Icon name="check" class="text-success" />
                <span>{{ done }}</span>
            </p>

            <!-- Failure and completion retain the full log path. -->
            <div v-if="failure || done" class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p class="text-2xs text-subtle">
                    The full output is in <span class="font-mono">{{ logPath }}</span> on that device.
                </p>
                <button type="button" :class="ui.linkButton(`gap-1 text-2xs text-subtle hover:text-content`)" @click="dismiss">
                    <Icon name="times" />Dismiss
                </button>
            </div>

            <ConfirmDialog
                :open="confirming"
                header="Rebuild this sandbox from your checkout?"
                confirm-label="Rebuild now"
                confirm-icon="bolt"
                :destructive="false"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <p>
                    The image is built from the working tree in {{ root }} — your sandbox keeps working through that, and it can take several minutes
                    — and then your sandbox restarts for about half a minute, after which this page reconnects on its own.
                </p>
                <p class="mt-3 text-xs text-muted">
                    Only the sandbox restarts — nothing else on that device is touched. Your files (in /work) are kept.
                </p>
<!-- The cost nobody can see from here: what is running now, and whether the restart hands it back. -->
                <p v-if="midTurn > 0" class="mt-3 text-xs text-warning">
                    {{ midTurn === 1 ? `An agent is` : `${midTurn} agents are` }} mid-turn right now, and the restart interrupts
                    {{ midTurn === 1 ? `its` : `their` }} work.
                    <template v-if="autoResume">
                        {{ midTurn === 1 ? `It is` : `They are` }} picked up again once the sandbox is back, since this sandbox resumes turns after a
                        restart.
                    </template>
                    <template v-else>
                        This sandbox doesn't resume turns after a restart, so {{ midTurn === 1 ? `it` : `they` }} would have to be sent again. The
                        build takes minutes — the fleet may well settle before it lands.
                    </template>
                </p>
            </ConfirmDialog>
        </template>

        <template v-else>
            <p class="text-2xs text-subtle">
                Runs <span class="font-mono">{{ base }}</span> from your checkout, not a published release. Rebuild to pick up code you've written since.
            </p>
            <!-- Two different gaps, one fallback: no checkout recorded, or nobody here can reach the machine holding it. -->
            <p v-if="root === undefined" class="text-2xs text-subtle">
                This sandbox doesn't record which checkout its image came from, so it can't start the rebuild for you. Run it there, and recreating it
                once with <span class="font-mono">dev-sandbox.sh</span> makes this a button from then on.
            </p>
            <p v-else class="text-2xs text-subtle">Run it on the device that holds that checkout:</p>
            <Code :code="command" :lang="commandLang(`unix`)" label="Rebuild command" :wrap="true" />
            <ConnectDeviceHint v-if="root" :slug="slug" gains="rebuilding from your checkout becomes a button here." />
        </template>
    </div>
</template>
