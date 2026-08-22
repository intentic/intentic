<script setup lang="ts">
import type { MachineSandboxOp } from "@intentic/sandbox-contract";
import { Button, ui, Code, commandLang, MachineRunLog, Notice, type NoticeModel, SegmentedControl, useOsPreference } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { manageMachineSandbox, useHostRunning } from "../composables/sandbox/useComputers";
import { DESKTOP_DOWNLOADS, desktopRecreateLink, desktopVersion, openDesktopLink } from "../environments/desktop";
import { bashCommand, psCommand } from "../environments/scriptCommand";

/* RECREATING THE SANDBOX, which the browser cannot do itself, but no longer has to hand to a terminal.
 *
 * The daemon holds no HOST Docker socket (its own engine is nested), so it can never recreate its own
 * container. Both moments that need one: an update to a newer image, and building an owner-approved
 * environment overlay: therefore end here, on the machine the container runs on. Two cards used to state
 * that separately and hand out a bash-only one-liner each; this is the one place that says it.
 *
 * Four renderings of the same operation, in the order of how little work they ask for:
 *   • the machine is a CONNECTED COMPUTER: a button, from any browser on any device, with the machine's own
 *     output streaming in beneath it. Nothing about this needs the user to be at that computer.
 *   • inside the desktop app: a button, because the app IS a process on that machine (intentic://recreate)
 *   • in a browser on Windows/Linux/macOS: the command, for the shell that machine actually has
 *   • in a browser with no app: the same command, plus where to get the app so the next one is a button
 *
 * The first is preferred over the second even inside the app: the deep link hands the window over to the
 * launcher face, and staying on the page you were reading is worth more than that handoff.
 *
 * All three modes work on all four, which they did not: rollback had no deep link and no Windows command, so
 * the one card that offers it was two renderings short of the two that do not.
 *
 * The mode rides the ARGUMENT SHAPE, not a flag, exactly as recreate.sh has always read it: a hash means
 * "build the approved overlay pinned to this digest", no hash means "pull the fresh :stable base".
 *
 * --- AND ONE ACTION THAT IS NOT A RECREATE AT ALL ---
 *
 * `Download` runs the same flow up to the point where the container would be touched, and stops: it pulls the
 * new image and rebuilds the environment recipe, leaving the sandbox running exactly what it was running.
 * Nothing restarts, nothing is interrupted, and an abandoned one costs nothing.
 *
 * It is here rather than on a component of its own because it needs all four renderings for the same reasons
 * the others do, and because splitting it out would be the second implementation of "ask this machine to run
 * `ic`". What it changes is the sentence underneath: with the download already done, an update stops being an
 * unbounded wait and becomes a restart of about half a minute, which is the whole point of offering it. */

type Action = `Download` | `Update` | `Rebuild` | `Roll back`;

const props = defineProps<{
    slug: string;
    /// The approved overlay's sha256: present for a rebuild, absent for everything else.
    hash?: string;
    /// What the button says. The command block is labelled from the same word, and: for the three modes that
    /// share the update script: it is also what selects between them.
    action: Action;
    /// Whether the image this action needs is already on that machine, so the wait it describes is the restart
    /// alone. Supplied by the update card, which is where the fact lives.
    ready?: boolean;
}>();

const { cmdOs } = useOsPreference();
const desktop = computed(() => desktopVersion() !== undefined);

// The machine, when it is one this sandbox can ask directly.
const hostId = useHostRunning(() => props.slug);
const OP: Record<Action, MachineSandboxOp> = { Download: `prepare`, Update: `update`, Rebuild: `rebuild`, "Roll back": `rollback` };

/* WHAT IT COSTS, said in the one place all four renderings read from, and said accurately, which it was not.
 *
 * This used to promise "a few minutes and this page loses the sandbox" for every mode. That is the download's
 * duration attached to the restart's description: the sandbox is up and serving through the pull and the
 * rebuild, and only the cutover at the end interrupts anything. Someone deciding whether to update mid-work
 * was being quoted an outage several times longer than the one that actually happens. */
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

/* Recreating THIS sandbox ends this page's connection to it, every time: that is what recreating means, and it
 * is why the command this replaces was always run somewhere else. Said before it starts rather than discovered
 * when the page goes quiet.
 *
 * `Download` is asked nothing, because it takes nothing: it never touches the container, so there is no
 * interruption to warn about and an abandoned one costs only bandwidth. A confirmation on it would be a dialog
 * whose honest text is "this changes nothing, proceed?", and it would make the safe option feel like the
 * dangerous one, which is the exact opposite of why it is offered. */
const runOnMachine = async (): Promise<void> => {
    const id = hostId.value;
    if (id === undefined || running.value) {
        return;
    }
    if (
        props.action !== `Download` &&
        !globalThis.confirm(
            `${props.action} this sandbox?\n\nIt restarts on that computer, so this page loses it for about half a minute. Your files are kept.`,
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

/* Rollback rides the update script with a flag: one script, three ways in, exactly as rebuild does with its
 * hash (see recreate.sh's argument-shape dispatch, and recreate.ps1's `-Rollback` switch beside its `-Hash`).
 * Windows used to fall through to the plain update command here, which is the one spelling where "Roll back"
 * printed a command that would have moved the sandbox the other way. */
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
        <!-- The machine is reachable from here, so this is a button wherever you are reading it: a phone on
             another continent included. -->
        <template v-if="hostId">
            <Button
                :label="running ? `${action} running…` : `${action} now`"
                class="self-start"
                :severity="action === `Download` ? `secondary` : undefined"
                :loading="running"
                @click="runOnMachine"
            >
                <template #icon><Icon :name="action === `Download` ? `download` : `bolt`" /></template>
            </Button>
            <p class="text-2xs text-subtle">Runs on the computer hosting this sandbox. {{ cost }}</p>
            <MachineRunLog
                v-if="running || lines.length > 0"
                :lines="lines"
                :running="running"
                empty="Starting on that computer…"
                note="Running on that computer: it keeps going even if you leave this page."
            />
            <Notice v-if="failure" :of="failure" />
            <p v-else-if="done" class="text-2xs text-muted">{{ done }}</p>
        </template>

        <!-- The desktop deep link carries all three swaps, rollback included: the app's own manager row offers
             the verb now, so the link that hands one over no longer has a mode it cannot express.

             Downloading is the one it cannot, because `intentic://recreate` has no parameter for "stop before
             the container is touched", so that action falls through to the command below, which the app's own
             machine can run as it stands. A button that quietly performed the whole update instead would be
             the worst possible outcome of clicking the safe option. -->
        <template v-else-if="desktop && action !== `Download`">
            <Button :label="`${action} now`" class="self-start" @click="openDesktopLink(desktopRecreateLink(slug, hash, action === `Roll back`))">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">Runs here, on this computer. {{ cost }}</p>
        </template>

        <template v-else>
            <ol class="ml-4 list-decimal text-2xs text-subtle">
                <li>Open a terminal on the computer that runs your sandbox.</li>
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
            <!-- Offered here rather than only at setup: this is the card someone reaches for the third time,
                 which is the moment "there is an app that does this" is worth reading. -->
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
