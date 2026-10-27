<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { devRebuildLogPath } from "@intentic/sandbox-contract/schemas/devices";
import { AnchoredOverlay, Button, Code, commandLang, ConfirmDialog, formatElapsed, type IconName, Notice, Picker, Section, useHoverIntent } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import ConnectDeviceHint from "../../../../parts/sandbox/ConnectDeviceHint.vue";
import DevRebuildProgress, { type SwapPolicy } from "./DevRebuildProgress.vue";
import { pastRebuild, timedSteps } from "./rebuildHistory";
import { useDevSwapWhenIdle } from "./useDevSwapWhenIdle";
import { turnInFlight } from "../../../../models/agent-status/agentStatus-standing";
import { useAgents } from "../../../../models/fleet/useAgents";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { useHostHolding } from "../../../../models/sandbox/devices/useDevices";
import { rebuildRunning, useDevRebuild } from "./useDevRebuild";
import { useT } from "@intentic/ui/i18n";

// Build a checkout-derived sandbox from its recorded source path: offer a button when reachable, otherwise the command to paste.
// Use the daemon's named dev-rebuild command over existing run_command, keeping compatibility with older machine agents.
// Poll the machine log through useDevRebuild: a detached build replaces its own daemon, so it cannot sustain a return stream.
// Keep run state outside this component and show either the offer or its progress card, never both.

const t = useT();

const props = defineProps<{
    slug: string;
    // The locally-built base, named on screen so "built from your checkout" is a fact the reader can check.
    base: string;
    // Host path of that checkout; absent on a sandbox handed a local image without one, which leaves only the command.
    root?: string | undefined;
    // Whether an approved recipe is waiting to be built. This rebuild applies it either way — the overlay rides the
    // image it builds — so the confirmation says so, at the moment the reader weighs it. It is also what makes the
    // rebuild the step this card is asking for (accent) rather than a tool kept to hand (boring).
    recipePending?: boolean;
}>();

// The door that can reach `root`, not merely one that reports the container: a PC answers through its Windows side
// and the distro on it alike, and the build is a `sh` line in a folder only one of them has. The distro's own door
// runs it directly, the Windows door crosses into the distro (the daemon sends the crossing with the command), and
// only a machine with no way to that folder at all falls through to the command below.
const hostId = useHostHolding(
    () => props.slug,
    () => props.root,
);
const { run, elapsed, start, adopt, dismiss, hold, release, cancel } = useDevRebuild(props.slug);

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
const anchorRef = ref<HTMLElement>();

const live = computed(() => rebuildRunning(run.phase));
// Told to the parent, whose badge says "Rebuilding" while it is, rather than "up to date" over a card rebuilding.
const rebuilding = defineModel<boolean>("rebuilding", { default: false });
watch(live, (now) => (rebuilding.value = now), { immediate: true });

// THE LAST RUN'S LENGTHS, which size the steps and say how long is left. Re-read when a run settles, since that is
// when the record changes; storage is not reactive by itself.
const past = ref(pastRebuild(props.slug));
watch(
    () => run.phase,
    () => (past.value = pastRebuild(props.slug)),
);
const steps = computed(() => timedSteps(past.value));

// The two costs, side by side: the build interrupts nothing, the swap at the end of it is the restart.
const cost = computed(() => t(`sandbox.devRebuild.cost`));

// THE OTHER OFFER, NAMED BEFORE IT IS MISTAKEN FOR THIS ONE. The Sandbox overview carries "Restart sandbox" when the
// two sides drift apart, and both offers read as one action on two tabs: both say "from your checkout", both end in a
// restart. They are not the same size. This builds a whole new image; that one restarts the sandbox already running,
// which is all a code change needs.
const insteadOfRestart = computed(() => t(`sandbox.devRebuild.insteadOfRestart`));

const command = computed(() =>
    props.root === undefined ? `pnpm rebuild:sandbox ${props.slug}` : `cd ${props.root} && pnpm rebuild:sandbox ${props.slug}`,
);

// The card opens for a pointer that stays, and waits for one that overshoots; the keyboard opens and closes it at once.
const hover = useHoverIntent({ open: 150, close: 150 });
// The overlay closes itself too (Escape, a press outside), which the clock has to hear.
const overlayOpen = computed({
    get: () => hover.shown.value,
    set: (open: boolean) => (open ? hover.show() : hover.hide()),
});

const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        hover.enter();
    }
};
const onLeave = (): void => hover.leave();
const onCardEnter = (): void => hover.cancel();
const onFocus = (): void => hover.show();
const onBlur = (): void => hover.hide();

const onButtonClick = (): void => {
    hover.hide();
    confirming.value = true;
};

// Where the detached build writes, named by the contract that also builds both command lines from it, so the path a
// reader is sent to is the path something actually writes.
const logPath = computed(() => devRebuildLogPath(props.slug));

// WHEN THE RESTART LANDS. Read off the machine (the hold file) and the sandbox (an idle-wait it keeps), so every tab and
// every reload says the same thing; a choice on its way is drawn at once. No hold mark at all is a daemon with no gate
// to hold a restart at, where the card says what it always said instead of offering a choice it cannot keep.
const idleSwap = useDevSwapWhenIdle();
const choosing = ref<SwapPolicy>();
const policyBusy = ref(false);
const policyTrouble = ref<string>();
const policy = computed((): SwapPolicy | undefined => {
    if (choosing.value !== undefined) {
        return choosing.value;
    }
    if (idleSwap.wait.value?.phase === `waiting`) {
        return `idle`;
    }
    if (run.hold === undefined) {
        return undefined;
    }
    return run.hold ? `manual` : `built`;
});
const waitingOn = computed(() => idleSwap.wait.value?.waitingOn ?? []);

// The sandbox's wait owns the hold while it is asked for, so leaving "once no agent is mid-turn" withdraws it first; the
// machine's file is then set to what was picked.
const setPolicy = async (next: SwapPolicy): Promise<void> => {
    const id = hostId.value;
    if (id === undefined) {
        return;
    }
    choosing.value = next;
    policyBusy.value = true;
    policyTrouble.value = undefined;
    try {
        if (next === `idle`) {
            await idleSwap.ask(id);
            return;
        }
        if (idleSwap.wait.value !== undefined) {
            await idleSwap.withdraw();
        }
        policyTrouble.value = next === `manual` ? await hold(id) : await release(id);
    } catch (error) {
        policyTrouble.value = errorMessage(error);
    } finally {
        policyBusy.value = false;
        choosing.value = undefined;
    }
};

const cancelling = ref(false);
const cancelTrouble = ref<string>();
const onCancel = async (): Promise<void> => {
    const id = hostId.value;
    if (id === undefined) {
        return;
    }
    cancelling.value = true;
    cancelTrouble.value = undefined;
    try {
        if (idleSwap.wait.value !== undefined) {
            await idleSwap.withdraw();
        }
        cancelTrouble.value = await cancel(id);
    } catch (error) {
        cancelTrouble.value = errorMessage(error);
    } finally {
        cancelling.value = false;
    }
};

// The restart's timing, picked at the moment of asking, beside the count of who it would cut. Waiting for the fleet to
// settle by default: a rebuild is minutes either way, and nobody's turn should be the price of not reading a picker.
const startPolicy = ref<SwapPolicy>(`idle`);
const START_POLICY_OPTIONS = computed(() => [
    { value: `built` as const, label: t(`sandbox.devRebuildProgress.policyBuilt`), icon: `bolt` as const },
    { value: `idle` as const, label: t(`sandbox.devRebuildProgress.policyIdle`), icon: `users` as const },
    { value: `manual` as const, label: t(`sandbox.devRebuildProgress.policyManual`), icon: `pause` as const },
]);

const execute = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    if (id === undefined || live.value) {
        return;
    }
    await start(id);
    // The hold is laid after the start, which clears whatever an earlier run left: the build is minutes from its gate.
    if (startPolicy.value !== `built` && rebuildRunning(run.phase)) {
        await setPolicy(startPolicy.value);
    }
};

// Nothing to show until a rebuild exists: one started here, one found already running, or one whose outcome hasn't
// been dismissed yet.
const following = computed(() => run.phase !== `idle`);
// Told to the parent, which moves what sits beside the button to the progress's foot once there is progress to draw.
const followingModel = defineModel<boolean>("following", { default: false });
watch(following, (now) => (followingModel.value = now), { immediate: true });

// WHAT THE RESTART WILL COST, COUNTED AT THE MOMENT OF ASKING. The build itself interrupts nothing, so the number
// that matters is read now rather than when the swap lands — by then it is a surprise instead of a decision, and
// waiting for the fleet to settle is free while nothing has started.
const { fleet } = useAgents();
const midTurn = computed(() => fleet.value.filter(turnInFlight).length);
const { settings } = useSandboxSettings();
const autoResume = computed(() => settings.value?.autoResumeOnRestart === true);
const interrupted = computed(() => {
    const count = midTurn.value;
    if (count === 0) {
        return undefined;
    }
    return autoResume.value ? t(`sandbox.devRebuild.midTurnResumed`, { count }, count) : t(`sandbox.devRebuild.midTurnLost`, { count }, count);
});

// The two costs as two steps, in the order they land: run through one sentence, the minutes that interrupt nothing
// read as the half-minute that does. Each one's length is the last run's where this browser watched one, and the usual words where it has not.
const STEPS = computed((): readonly { icon: IconName; label: string; note: string; takes: string }[] => {
    const took = past.value?.ms;
    return [
        {
            icon: `hammer`,
            label: t(`sandbox.devRebuild.buildsImage`),
            note: t(`sandbox.devRebuild.keepWorking`),
            takes: took === undefined ? t(`sandbox.devRebuild.minutes`) : `~${formatElapsed(Math.round((took.compile + took.image) / 1000))}`,
        },
        {
            icon: `refresh`,
            label: t(`sandbox.devRebuild.restartsSandbox`),
            note: t(`sandbox.devRebuild.reconnectsOnOwn`),
            takes: took === undefined ? `~30s` : `~${formatElapsed(Math.round(took.swap / 1000))}`,
        },
    ];
});

// The last segment is what tells two checkouts apart, so it never truncates; the parent stays, dimmed, to be checkable.
const checkout = computed(() => {
    const path = props.root ?? ``;
    const cut = path.lastIndexOf(`/`);
    return cut <= 0 ? { parent: ``, name: path } : { parent: path.slice(0, cut + 1), name: path.slice(cut + 1) };
});
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- The machine holding the checkout is reachable from here, so this is a button wherever you're reading it. -->
        <template v-if="hostId && root">
            <!-- The button, and beside it the way back while there is no run below to carry it. -->
            <div v-if="!live" class="flex flex-wrap items-start justify-between gap-2">
                <div
                    ref="anchorRef"
                    class="inline-flex"
                    @pointerenter="onEnter"
                    @pointerleave="onLeave"
                    @focusin="onFocus"
                    @focusout="onBlur"
                >
                    <!-- A hammer, not the bolt a swap onto an image that already exists wears: this one builds it first. -->
                    <Button :label="t(`sandbox.devRebuild.rebuildCheckout`)" size="small" :tier="recipePending ? `accent` : `boring`" @click="onButtonClick">
                        <template #icon><Icon name="hammer" /></template>
                    </Button>
                </div>
                <slot v-if="!following" name="trouble" />
            </div>

            <AnchoredOverlay v-model="overlayOpen" :anchor="anchorRef" side="right" cross="start">
                <div class="flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2.5 p-3 text-left" @pointerenter="onCardEnter" @pointerleave="onLeave">
                    <p class="text-2xs text-muted">
                        {{ t(`sandbox.devRebuild.runs`) }} <span class="font-mono text-content">{{ base }}</span>
                        {{ t(`sandbox.devRebuild.checkoutNotPublishedRelease`) }}
                    </p>

                    <Section :label="t(`sandbox.devRebuild.hostCommand`)" density="dense">
                        <template #actions>
                            <span class="truncate font-mono text-2xs text-subtle">{{ root }}</span>
                        </template>
                        <Code :code="command" :lang="commandLang(`unix`)" :wrap="true" />
                    </Section>

                    <p class="text-2xs leading-relaxed text-subtle">{{ cost }}</p>
                    <p class="text-2xs leading-relaxed text-subtle">{{ insteadOfRestart }}</p>
                </div>
            </AnchoredOverlay>

            <!-- The whole state of a detached build, drawn as the three things it does; the log lives inside it,
                 behind a toggle, because for most of a rebuild it is the one thing nobody needs. -->
            <DevRebuildProgress
                v-if="following"
                :run="run"
                :elapsed="elapsed"
                :log-path="logPath"
                :slug="slug"
                :steps="steps"
                :past-tasks="past?.tasks"
                :policy="policy"
                :policy-busy="policyBusy"
                :policy-trouble="policyTrouble"
                :waiting-on="waitingOn"
                :mid-turn="midTurn"
                :auto-resume="autoResume"
                :cancelling="cancelling"
                :cancel-trouble="cancelTrouble"
                @update:policy="setPolicy"
                @restart-now="setPolicy(`built`)"
                @cancel="onCancel"
                @dismiss="dismiss"
            >
                <template #trouble><slot name="trouble" /></template>
            </DevRebuildProgress>

            <ConfirmDialog
                :open="confirming"
                :header="t(`sandbox.devRebuild.rebuildCheckout2`)"
                header-icon="box"
                :confirm-label="t(`sandbox.words.rebuildNow`)"
                confirm-icon="bolt"
                :destructive="false"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <div class="flex flex-col gap-3">
                    <div class="flex items-center gap-2 rounded-md bg-canvas px-2.5 py-2 font-mono text-xs">
                        <Icon name="folder-open" class="shrink-0 text-subtle" />
                        <span class="flex min-w-0" v-tooltip.top="root">
                            <span class="truncate text-subtle">{{ checkout.parent }}</span>
                            <span class="shrink-0 text-content">{{ checkout.name }}</span>
                        </span>
                    </div>

                    <ol class="flex flex-col gap-3">
                        <li v-for="step in STEPS" :key="step.label" class="flex items-start gap-2.5">
                            <span class="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-primary-600/15 text-accent">
                                <Icon :name="step.icon" />
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="block text-xs text-content">{{ step.label }}</span>
                                <span class="block text-2xs text-subtle">{{ step.note }}</span>
                            </span>
                            <span class="mt-px shrink-0 font-mono text-2xs tabular-nums text-muted">{{ step.takes }}</span>
                        </li>
                    </ol>

                    <!-- When the restart lands, decided here where the mid-turn count below says what it would cut. -->
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pl-8">
                        <span class="text-2xs text-muted">{{ t(`sandbox.devRebuildProgress.restartLabel`) }}</span>
                        <Picker
                            v-model="startPolicy"
                            :options="START_POLICY_OPTIONS"
                            variant="ghost"
                            :aria-label="t(`sandbox.devRebuildProgress.restartLabel`)"
                            class="text-2xs"
                        />
                    </div>

                    <p class="flex items-center gap-2 text-2xs text-muted">
                        <Icon name="check" class="shrink-0 text-success" />
                        <span>{{ t(`sandbox.devRebuild.workKept`) }}</span>
                    </p>

                    <!-- Said here and nowhere on the card: whether this also settles the pending recipe is the question
                         at the moment of asking, and the card's badge already says one is waiting. -->
                    <p v-if="recipePending" class="flex items-center gap-2 text-2xs text-muted">
                        <Icon name="check" class="shrink-0 text-success" />
                        <span>{{ t(`sandbox.devRebuild.approvedRecipeAppliedPart`) }}</span>
                    </p>

                    <!-- The cost nobody can see from here: what is running now, and whether the restart hands it back. Only
                         under "as soon as it's built": the other two never cut a turn. -->
                    <Notice v-if="interrupted && startPolicy === `built`" tone="warning" class="text-2xs">{{ interrupted }}</Notice>
                </div>
            </ConfirmDialog>
        </template>

        <template v-else>
            <!-- Two different gaps, one fallback: no checkout recorded, or nobody here can reach the machine holding it. -->
            <p v-if="root === undefined" class="text-2xs text-subtle">
                {{ t(`sandbox.devRebuild.sandboxDoesntRecordCheckout`) }} <span class="font-mono">dev-sandbox.sh</span>
                {{ t(`sandbox.devRebuild.makesButtonOn`) }}
            </p>
            <Code :code="command" :lang="commandLang(`unix`)" :label="t(`sandbox.devRebuild.rebuildCommand`)" :wrap="true" />
            <ConnectDeviceHint v-if="root" :slug="slug" :gains="t(`sandbox.devRebuild.becomesButton`)" />
        </template>
    </div>
</template>
