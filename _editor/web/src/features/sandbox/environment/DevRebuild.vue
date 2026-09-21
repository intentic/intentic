<script setup lang="ts">
import { devRebuildLogPath } from "@intentic/sandbox-contract";
import { AnchoredOverlay, Button, Code, commandLang, ConfirmDialog, type IconName, Notice } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import ConnectDeviceHint from "../devices/ConnectDeviceHint.vue";
import DevRebuildProgress from "./DevRebuildProgress.vue";
import { turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { useSandboxSettings } from "../overview/useSandboxSettings";
import { useHostHolding } from "../devices/useDevices";
import { rebuildRunning, useDevRebuild } from "./useDevRebuild";
import { useT } from "@intentic/ui/i18n";

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
//
// The offer and the run are never on screen at once: while one is going, the card below IS the state of this button,
// and a disabled button spinning beside a progress card is the same wait drawn twice.

const t = useT();

const props = defineProps<{
    slug: string;
    // The locally-built base, named on screen so "built from your checkout" is a fact the reader can check.
    base: string;
    // Host path of that checkout; absent on a sandbox handed a local image without one, which leaves only the command.
    root?: string | undefined;
    // Whether an approved recipe is waiting to be built. This rebuild applies it either way — the overlay rides the
    // image it builds — so the offer says so, and stands down to the quicker button that does only that.
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

// Nothing to show until a rebuild exists: one started here, one found already running, or one whose outcome hasn't
// been dismissed yet.
const following = computed(() => run.phase !== `idle`);

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
    const who = count === 1 ? `An agent is` : `${count} agents are`;
    return autoResume.value
        ? `${who} mid-turn — interrupted, then picked up once the sandbox is back.`
        : `${who} mid-turn — interrupted, and would need sending again.`;
});

// The two costs as two steps, in the order they land: run through one sentence, the minutes that interrupt nothing
// read as the half-minute that does.
const STEPS = computed((): readonly { icon: IconName; label: string; note: string; takes: string }[] => [
    { icon: `hammer`, label: t(`sandbox.devRebuild.buildsImage`), note: t(`sandbox.devRebuild.keepWorking`), takes: `minutes` },
    { icon: `refresh`, label: t(`sandbox.devRebuild.restartsSandbox`), note: t(`sandbox.devRebuild.reconnectsOnOwn`), takes: `~30s` },
]);

// The last segment is what tells two checkouts apart, so it never truncates; the parent stays, dimmed, to be checkable.
const checkout = computed(() => {
    const path = props.root ?? ``;
    const cut = path.lastIndexOf(`/`);
    return cut <= 0 ? { parent: ``, name: path } : { parent: path.slice(0, cut + 1), name: path.slice(cut + 1) };
});
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- Above the button it describes, not under the other one: the reader's question at this moment is whether
             this rebuild also settles the recipe, and the answer is the first thing it reads. -->
        <p v-if="recipePending && !live" class="text-xs text-content">{{ t(`sandbox.devRebuild.orRebuildFromCheckout`) }}</p>

        <!-- The machine holding the checkout is reachable from here, so this is a button wherever you're reading it. -->
        <template v-if="hostId && root">
            <div
                v-if="!live"
                ref="anchorRef"
                class="inline-flex self-start"
                @pointerenter="onEnter"
                @pointerleave="onLeave"
                @focusin="onFocus"
                @focusout="onBlur"
            >
                <!-- A hammer, never the bolt the recipe's own rebuild wears: two identical glyphs on one card is what
                     made these read as one action offered twice. -->
                <Button
                    :label="t(`sandbox.devRebuild.rebuildCheckout`)"
                    size="small"
                    :severity="recipePending ? `secondary` : undefined"
                    @click="onButtonClick"
                >
                    <template #icon><Icon name="hammer" /></template>
                </Button>
            </div>

            <AnchoredOverlay v-model="overlayOpen" :anchor="anchorRef" side="right" cross="start">
                <div class="flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2.5 p-3 text-left" @pointerenter="onCardEnter" @pointerleave="onLeave">
                    <p class="text-2xs text-muted">
                        {{ t(`sandbox.devRebuild.runs`) }} <span class="font-mono text-content">{{ base }}</span>
                        {{ t(`sandbox.devRebuild.checkoutNotPublishedRelease`) }}
                    </p>

                    <div class="flex flex-col gap-1">
                        <div class="flex items-baseline justify-between gap-2">
                            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`sandbox.devRebuild.hostCommand`) }}</span>
                            <span class="truncate font-mono text-2xs text-subtle">{{ root }}</span>
                        </div>
                        <Code :code="command" :lang="commandLang(`unix`)" :wrap="true" />
                    </div>

                    <p class="text-2xs leading-relaxed text-subtle">{{ cost }}</p>
                </div>
            </AnchoredOverlay>

            <!-- The whole state of a detached build, drawn as the three things it does; the log lives inside it,
                 behind a toggle, because for most of a rebuild it is the one thing nobody needs. -->
            <DevRebuildProgress v-if="following" :run="run" :elapsed="elapsed" :log-path="logPath" @dismiss="dismiss" />

            <ConfirmDialog
                :open="confirming"
                :header="t(`sandbox.devRebuild.rebuildCheckout2`)"
                header-icon="box"
                :confirm-label="t(`sandbox.devRebuild.rebuildNow`)"
                confirm-icon="bolt"
                :destructive="false"
                @cancel="confirming = false"
                @confirm="execute"
            >
                <div class="flex flex-col gap-3">
                    <div class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-xs">
                        <Icon name="folder-open" class="shrink-0 text-subtle" />
                        <span class="flex min-w-0" :title="root">
                            <span class="truncate text-subtle">{{ checkout.parent }}</span>
                            <span class="shrink-0 text-content">{{ checkout.name }}</span>
                        </span>
                    </div>

                    <ol class="flex flex-col gap-3">
                        <li v-for="step in STEPS" :key="step.label" class="flex items-start gap-2.5">
                            <span class="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-primary-600/15 text-primary-500">
                                <Icon :name="step.icon" />
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="block text-xs text-content">{{ step.label }}</span>
                                <span class="block text-2xs text-subtle">{{ step.note }}</span>
                            </span>
                            <span class="mt-px shrink-0 font-mono text-2xs tabular-nums text-muted">{{ step.takes }}</span>
                        </li>
                    </ol>

                    <p class="flex items-center gap-2 text-2xs text-muted">
                        <Icon name="check" class="shrink-0 text-success" />
                        <span>/work is kept. Nothing else on that device is touched.</span>
                    </p>

                    <!-- At the moment of asking, since this is what the reader is weighing against the quicker button. -->
                    <p v-if="recipePending" class="flex items-center gap-2 text-2xs text-muted">
                        <Icon name="check" class="shrink-0 text-success" />
                        <span>{{ t(`sandbox.devRebuild.approvedRecipeAppliedPart`) }}</span>
                    </p>

                    <!-- The cost nobody can see from here: what is running now, and whether the restart hands it back. -->
                    <Notice v-if="interrupted" tone="warning" class="text-2xs">{{ interrupted }}</Notice>
                </div>
            </ConfirmDialog>
        </template>

        <template v-else>
            <p class="text-2xs text-subtle">
                {{ t(`sandbox.devRebuild.runs`) }} <span class="font-mono">{{ base }}</span> {{ t(`sandbox.devRebuild.checkoutNotPublishedRelease`) }}
            </p>
            <!-- Two different gaps, one fallback: no checkout recorded, or nobody here can reach the machine holding it. -->
            <p v-if="root === undefined" class="text-2xs text-subtle">
                {{ t(`sandbox.devRebuild.sandboxDoesntRecordCheckout`) }} <span class="font-mono">dev-sandbox.sh</span>
                {{ t(`sandbox.devRebuild.makesButtonOn`) }}
            </p>
            <p v-else class="text-2xs text-subtle">{{ t(`sandbox.devRebuild.runOnDeviceHolds`) }}</p>
            <Code :code="command" :lang="commandLang(`unix`)" :label="t(`sandbox.devRebuild.rebuildCommand`)" :wrap="true" />
            <ConnectDeviceHint v-if="root" :slug="slug" gains="rebuilding from your checkout becomes a button here." />
        </template>
    </div>
</template>
