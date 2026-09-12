<script setup lang="ts">
import { Button, Code, commandLang, ConfirmDialog, DeviceRunLog, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import ConnectDeviceHint from "../devices/ConnectDeviceHint.vue";
import { manageDeviceSandbox, useHostRunning } from "../devices/useDevices";

// Rebuilding a sandbox whose base was compiled from a checkout, from that checkout. Not HostRecreate's flow: that one
// swaps between images that already exist, and the image this asks for — the working tree as it is now — is not one of
// them until something builds it. A button where the machine is reachable, the command to paste where it isn't; the
// checkout's path is the sandbox's own record of where it came from, never a guess.

const props = defineProps<{
    slug: string;
    // The locally-built base, named on screen so "built from your checkout" is a fact the reader can check.
    base: string;
    // Host path of that checkout; absent on a sandbox handed a local image without one, which leaves only the command.
    root?: string | undefined;
}>();

const hostId = useHostRunning(() => props.slug);

const running = ref(false);
const lines = ref<string[]>([]);
const failure = ref<NoticeModel | undefined>(undefined);
const done = ref<string | undefined>(undefined);
const confirming = ref(false);

// The two costs, side by side: the build interrupts nothing, the swap at the end of it is the restart.
const cost = `It compiles the image first — your sandbox keeps working through that, and it can take several minutes — then restarts your sandbox for about half a minute. Your files (in /work) are kept.`;

const command = computed(() =>
    props.root === undefined ? `pnpm rebuild:sandbox ${props.slug}` : `cd ${props.root} && pnpm rebuild:sandbox ${props.slug}`,
);

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
        done.value = await manageDeviceSandbox(id, props.slug, `dev-rebuild`, { onLine: (line) => lines.value.push(line) });
    } catch (error) {
        failure.value = noticeFrom(error, `Couldn't rebuild this sandbox from its checkout.`);
    } finally {
        running.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- Leads like every other offer on these cards ("To finish, rebuild your sandbox:"), so a second offer under
             the first reads as its own thing rather than as more explanation of it. -->
        <p class="text-xs font-medium text-content">Rebuild it from your checkout:</p>
        <p class="text-2xs text-subtle">
            This sandbox runs <span class="font-mono">{{ base }}</span
            >, an image built from your checkout rather than a published release. Rebuilding from that checkout is how it picks up code you have
            written since.
        </p>

        <!-- The machine holding the checkout is reachable from here, so this is a button wherever you're reading it. -->
        <template v-if="hostId && root">
            <Button
                :label="running ? `Rebuilding…` : `Rebuild from checkout`"
                size="small"
                class="self-start"
                :loading="running"
                @click="confirming = true"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">
                Runs <span class="font-mono">pnpm rebuild:sandbox</span> in {{ root }}, on the device hosting this sandbox. {{ cost }}
            </p>
            <DeviceRunLog
                v-if="running || lines.length > 0"
                :lines="lines"
                :running="running"
                empty="Starting on that device…"
                note="Running on that device: it keeps going even if you leave this page."
            />
            <Notice v-if="failure" :of="failure" />
            <p v-else-if="done" class="text-2xs text-muted">{{ done }}</p>

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
                    The image is built from the working tree in {{ root }} — your sandbox keeps working through that — and then your sandbox restarts
                    for about half a minute, after which this page reconnects on its own.
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
