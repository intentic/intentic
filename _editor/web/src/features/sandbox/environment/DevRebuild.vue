<script setup lang="ts">
import { AnchoredOverlay, Button, Code, commandLang, ConfirmDialog, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref } from "vue";
import ConnectDeviceHint from "../devices/ConnectDeviceHint.vue";
import { runDeviceCommand, useHostRunning } from "../devices/useDevices";

// Rebuilding a sandbox whose base was compiled from a checkout, from that checkout. Not HostRecreate's flow: that one
// swaps between images that already exist, and the image this asks for — the working tree as it is now — is not one of
// them until something builds it. A button where the machine is reachable, the command to paste where it isn't; the
// checkout's path is the sandbox's own record of where it came from, never a guess.
//
// It rides the named-command door (`dev-rebuild`, beside `dev-reload`) rather than a machine-side sandbox op, and that
// is the load-bearing choice: the closed set of commands lives in the DAEMON and what crosses to the machine is a line
// for `run_command`, a tool every released agent already has. A new op would instead have to reach a machine whose
// agent is usually older than the sandbox asking — which is every dogfooding machine, and is what made the first
// attempt answer "Input validation failed". Nothing streams back for the same reason: the build is detached out there.

const props = defineProps<{
    slug: string;
    // The locally-built base, named on screen so "built from your checkout" is a fact the reader can check.
    base: string;
    // Host path of that checkout; absent on a sandbox handed a local image without one, which leaves only the command.
    root?: string | undefined;
}>();

const hostId = useHostRunning(() => props.slug);

const starting = ref(false);
const failure = ref<NoticeModel | undefined>(undefined);
const done = ref<string | undefined>(undefined);
const confirming = ref(false);

const overlayOpen = ref(false);
const anchorRef = ref<HTMLElement>();

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

// Where the detached build writes, so a rebuild that never comes back can still say why. Same folder ic logs its own
// recreates into, and the daemon builds the same path when it forms the command (hosts/device-commands.ts).
const logPath = computed(() => `~/.intentic/logs/dev-rebuild-${props.slug}.log`);

const execute = async (): Promise<void> => {
    confirming.value = false;
    const id = hostId.value;
    if (id === undefined || starting.value) {
        return;
    }
    starting.value = true;
    failure.value = undefined;
    done.value = undefined;
    try {
        // The machine's own sentence either way: a refusal (commands switched off, no checkout) is a value here, not a
        // throw, and only an unreachable device throws.
        const result = await runDeviceCommand(id, `dev-rebuild`);
        done.value = result.ok ? result.message : undefined;
        failure.value = result.ok ? undefined : { tone: `warning`, title: `That device didn't start the rebuild.`, detail: result.message };
    } catch (error) {
        failure.value = noticeFrom(error, `Couldn't reach that device to rebuild this sandbox.`);
    } finally {
        starting.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <p class="text-2xs text-subtle">
            Runs <span class="font-mono">{{ base }}</span> from your checkout, not a published release. Rebuild to pick up code you've written since.
        </p>

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
                    :label="starting ? `Starting…` : `Rebuild from checkout`"
                    size="small"
                    :loading="starting"
                    @click="onButtonClick"
                >
                    <template #icon><Icon name="bolt" /></template>
                </Button>
            </div>

            <AnchoredOverlay v-model="overlayOpen" :anchor="anchorRef" side="right" cross="start">
                <div
                    class="flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 p-3 text-left"
                    @pointerenter="onCardEnter"
                    @pointerleave="onLeave"
                >
                    <div class="flex items-baseline justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Host command</span>
                        <span class="truncate font-mono text-2xs text-subtle">{{ root }}</span>
                    </div>
                    <Code :code="command" :lang="commandLang(`unix`)" :wrap="true" />
                    <p class="text-2xs leading-relaxed text-muted">{{ cost }}</p>
                </div>
            </AnchoredOverlay>

            <Notice v-if="failure" :of="failure" />
            <!--
                The build outlives this page: the sandbox coming back is its outcome, and the log is the only place a
                build that never finishes can say why — so it is named here rather than only in the failure case.
            -->
            <template v-else-if="done">
                <p class="text-2xs text-muted">{{ done }}</p>
                <p class="text-2xs text-subtle">
                    If it hasn't come back in a few minutes, <span class="font-mono">{{ logPath }}</span> on that device says how far it got.
                </p>
            </template>

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
            </ConfirmDialog>
        </template>

        <template v-else>
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
