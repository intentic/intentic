<script setup lang="ts">
import type { MachineSandboxOp } from "@intentic/sandbox-contract";
import { ui, Code, commandLang, Notice, type NoticeModel, SegmentedControl, useOsPreference } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref } from "vue";
import MachineRunLog from "../pages/sandbox/MachineRunLog.vue";
import { manageMachineSandbox, useHostRunning } from "../composables/sandbox/useComputers";
import { DESKTOP_DOWNLOADS, desktopRecreateLink, desktopVersion, openDesktopLink } from "../environments/desktop";
import { bashCommand, psCommand } from "../environments/scriptCommand";

/* RECREATING THE SANDBOX — which the browser cannot do itself, but no longer has to hand to a terminal.
 *
 * The daemon holds no HOST Docker socket (its own engine is nested), so it can never recreate its own
 * container. Both moments that need one — an update to a newer image, and building an owner-approved
 * environment overlay — therefore end here, on the machine the container runs on. Two cards used to state
 * that separately and hand out a bash-only one-liner each; this is the one place that says it.
 *
 * Four renderings of the same operation, in the order of how little work they ask for:
 *   • the machine is a CONNECTED COMPUTER — a button, from any browser on any device, with the machine's own
 *     output streaming in beneath it. Nothing about this needs the user to be at that computer.
 *   • inside the desktop app — a button, because the app IS a process on that machine (intentic://recreate)
 *   • in a browser on Windows/Linux/macOS — the command, for the shell that machine actually has
 *   • in a browser with no app — the same command, plus where to get the app so the next one is a button
 *
 * The first is preferred over the second even inside the app: the deep link hands the window over to the
 * launcher face, and staying on the page you were reading is worth more than that handoff.
 *
 * The mode rides the ARGUMENT SHAPE, not a flag, exactly as recreate.sh has always read it: a hash means
 * "build the approved overlay pinned to this digest", no hash means "pull the fresh :stable base". */

const props = defineProps<{
    slug: string;
    /// The approved overlay's sha256 — present for a rebuild, absent for an update or a rollback.
    hash?: string;
    /// What the button says. The command block is labelled from the same word, and — for the two modes that
    /// share the update script — it is also what selects between them.
    action: `Update` | `Rebuild` | `Roll back`;
}>();

const { cmdOs } = useOsPreference();
const desktop = computed(() => desktopVersion() !== undefined);

// The machine, when it is one this sandbox can ask directly.
const hostId = useHostRunning(() => props.slug);
const OP: Record<`Update` | `Rebuild` | `Roll back`, MachineSandboxOp> = { Update: `update`, Rebuild: `rebuild`, "Roll back": `rollback` };

const running = ref(false);
const lines = ref<string[]>([]);
const failure = ref<NoticeModel | undefined>(undefined);
const done = ref<string | undefined>(undefined);

/* Recreating THIS sandbox ends this page's connection to it, every time — that is what recreating means, and it
 * is why the command this replaces was always run somewhere else. Said before it starts rather than discovered
 * when the page goes quiet. */
const runOnMachine = async (): Promise<void> => {
    const id = hostId.value;
    if (id === undefined || running.value) {
        return;
    }
    if (
        !globalThis.confirm(
            `${props.action} this sandbox?\n\nIt restarts on that computer and this page loses it for a few minutes. Your files are kept.`,
        )
    ) {
        return;
    }
    running.value = true;
    failure.value = undefined;
    done.value = undefined;
    lines.value = [];
    try {
        done.value = await manageMachineSandbox(id, props.slug, OP[props.action], {
            ...(props.hash === undefined ? {} : { hash: props.hash }),
            onLine: (line) => lines.value.push(line),
        });
    } catch (error) {
        failure.value = noticeFrom(error, `Couldn't rebuild this host.`);
    } finally {
        running.value = false;
    }
};

const command = computed(() => {
    const key = props.hash === undefined ? `update` : `rebuild`;
    if (cmdOs.value === `windows`) {
        const args = props.hash === undefined ? `-Slug ${props.slug}` : `-Slug ${props.slug} -Hash ${props.hash}`;
        return psCommand(props.hash === undefined ? `updatePs1` : `rebuildPs1`, ``, args);
    }
    // Rollback rides the update script with a flag — one script, three ways in, exactly as rebuild does with
    // its hash (see recreate.sh's argument-shape dispatch).
    if (props.action === `Roll back`) {
        return bashCommand(key, ``, `${props.slug} --rollback`);
    }
    return bashCommand(key, ``, props.hash === undefined ? props.slug : `${props.slug} ${props.hash}`);
});
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- The machine is reachable from here, so this is a button wherever you are reading it — a phone on
             another continent included. All three modes work: unlike the desktop deep link, a rollback has a
             verb on this path. -->
        <template v-if="hostId">
            <Button :label="running ? `${action} running…` : `${action} now`" class="self-start" :loading="running" @click="runOnMachine">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">
                Runs on the computer hosting this sandbox. It takes a few minutes and this page loses the sandbox while it restarts; your files (in
                /work) are kept.
            </p>
            <MachineRunLog v-if="running || lines.length > 0" :lines="lines" :running="running" />
            <Notice v-if="failure" :of="failure" />
            <p v-else-if="done" class="text-2xs text-muted">{{ done }}</p>
        </template>

        <!-- The desktop deep link carries update and rebuild only; a rollback has no verb there, so it falls
             through to the command block rather than being wired to a link that would run the wrong swap. -->
        <template v-else-if="desktop && action !== `Roll back`">
            <Button :label="`${action} now`" class="self-start" @click="openDesktopLink(desktopRecreateLink(slug, hash))">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">Runs here, on this computer. It takes a few minutes; your files (in /work) are kept.</p>
        </template>

        <template v-else>
            <ol class="ml-4 list-decimal text-2xs text-subtle">
                <li>Open a terminal on the computer that runs your sandbox.</li>
                <li>Copy and run the command below. It takes a few minutes; your files (in /work) are kept.</li>
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
            <!-- Offered here rather than only at setup: this is the card someone reaches for the third time,
                 which is the moment "there is an app that does this" is worth reading. -->
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                <span>Skip the terminal next time —</span>
                <a :href="DESKTOP_DOWNLOADS.windows" class="text-link hover:underline">Intentic for Windows</a>
                <span>·</span>
                <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="text-link hover:underline">Linux</a>
                <span>does this with a button.</span>
            </p>
        </template>
    </div>
</template>
