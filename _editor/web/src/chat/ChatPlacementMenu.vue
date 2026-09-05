<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { boxNameOf } from "../composables/agents/fleetScope";
import type { Conversation } from "../composables/chat/conversation";
import { type BoxFleet, otherBoxes, subscribe as watchOtherBoxes } from "../composables/sandbox/fleetAcross";
import { useRunners } from "../composables/sandbox/useRunners";

/* WHERE THIS CONVERSATION RUNS. Three kinds of answer, in one list, because they are one question:
 *
 *   This sandbox      the workspace on screen, on the machine it lives on.
 *   A runner          a container of its own on another of your computers, running THIS sandbox's workspace
 *                     (docs/remote-runners-plan.md). What moves is whose CPU and memory the turn spends.
 *   Another sandbox   a different workspace, on a different machine, with its own files, its own connected
 *                     accounts and its own agents. What moves is the WORK's address.
 *
 * The third one is why this menu exists at all now. Starting work in another box used to mean switching the
 * whole app to it first, which tears down the chat, the editor, the tree, the fleet and every extension
 * (sandboxScope) to answer "also do this over there", and lands you somewhere you did not want to be. The turn
 * is a detached run on a daemon and every window is only a renderer of it (turnStream), so the browser can
 * simply address another daemon: the tab stays here, streams from there, and steers and stops there too.
 *
 * WHAT THE THIRD ONE COSTS, and the composer says it at each control rather than in a banner: the workspace
 * around the message is still this box's, so a remote conversation does not carry this box's open file, its
 * @-mention completions, its personas or its account pick. The provider and model do cross, and the target
 * daemon serves the turn on its own credentials (turnRequest.ts spells out each omission).
 *
 * OFFERED ONLY BEFORE THE FIRST TURN. Placement is part of a conversation's identity: the daemon latches it
 * with the branch on the first turn, and the box that holds the record, the worktree and the session is the
 * only one that can run the next turn. So once it has run, this reads rather than asks, and the way to work
 * somewhere else is a new agent, which is one click away.
 *
 * An OFFLINE runner and an unanswering sandbox are both listed and neither is selectable: they are still
 * yours, their machine is simply asleep or unreachable, and offering them would only produce a turn that comes
 * back saying so. */

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

const { runners } = useRunners();

/* THE OTHER BOXES ARE READ WHILE THIS MENU IS OPEN AND NOT A MOMENT LONGER, the switcher popover's rule, for
 * the switcher popover's reason: this store polls every sandbox the account owns, and a control that is
 * mounted only while a reader is looking at it is exactly the subscriber it was written for. What it buys is
 * the one thing this list cannot fake, whether a box would answer a turn sent to it right now. */
onUnmounted(watchOtherBoxes());

const picked = computed(() => conversation.box.value);
const pickedRunner = computed(() => conversation.runner.value);
// The board has known this conversation ⇒ its placement is settled (Conversation.registered latches on the
// first roster frame, or on the daemon's ack for a box this browser does not stream). A draft is the whole
// window in which this control means anything.
const settled = computed(() => conversation.registered.value);

/* What the row says under the name. An OUTDATED runner is still offered, and says so: it runs turns, it is
 * simply behind this sandbox's build, and the choice between "run it there now" and "update it first" is the
 * user's (the Devices view has the button). */
const detail = (runner: { online: boolean; parity: string; facts?: { cpus: number; load: number } }): string => {
    if (!runner.online) {
        return `Offline — wake that machine to use it`;
    }
    const load = runner.facts === undefined ? `Ready` : `${runner.facts.cpus} cores · load ${runner.facts.load.toFixed(2)}`;
    return runner.parity === `outdated` ? `${load} · older build than this sandbox` : load;
};

// A box that has never answered is not offered: a turn posted to a daemon that is not there fails at the door,
// and "it may be asleep" is a better thing to read before the press than after it.
const answering = (box: BoxFleet): boolean => box.state === `ready`;

const boxDetail = (box: BoxFleet): string =>
    box.state === `ready`
        ? `Its workspace, its accounts, its agents`
        : box.state === `reading`
          ? `Checking whether it's awake…`
          : `Not answering — it may be asleep`;

// Where it ended up, in the words the row that chose it used. Named from the roster rather than from anything
// stored on the conversation, so a box renamed since keeps this sentence true.
const placedAt = computed(() => {
    if (picked.value !== undefined) {
        return `in “${boxNameOf.value.get(picked.value) ?? `another sandbox`}”`;
    }
    return pickedRunner.value === undefined ? `here` : `on “${pickedRunner.value}”`;
});

const place = (at: { box?: string; runner?: string }): void => {
    if (settled.value) {
        return;
    }
    /* THE TWO AXES ARE ONE CHOICE, so each pick clears the other. A runner belongs to the sandbox that paired
     * it, so "that runner, but in the other box" is not a thing that exists: the id would name nothing there,
     * and the body builder drops it anyway (turnRequest.ts). One list, one answer. */
    conversation.box.value = at.box;
    conversation.runner.value = at.runner;
    emit(`selected`);
};
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': picked === undefined && pickedRunner === undefined }"
            :disabled="settled"
            @click="place({})"
        >
            <Icon name="box" class="mt-0.5 text-xs" :class="picked === undefined && pickedRunner === undefined ? 'text-primary-500' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">This sandbox</span>
                <span class="text-2xs text-subtle">Runs on the machine this workspace lives on.</span>
            </span>
        </button>
        <button
            v-for="runner in runners"
            :key="runner.id"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': pickedRunner === runner.id }"
            :disabled="settled || !runner.online"
            @click="place({ runner: runner.id })"
        >
            <Icon name="desktop" class="mt-0.5 text-xs" :class="pickedRunner === runner.id ? 'text-primary-500' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ runner.id }}</span>
                <span class="text-2xs text-subtle">{{ detail(runner) }}</span>
            </span>
        </button>

        <!-- The other workspaces on this account. A heading rather than a bare run of rows: the two above are
             this sandbox and its own machines, and these are somewhere else entirely, which is a bigger step
             than the gap between two rows can say. Absent on an account with one sandbox, where it would be a
             heading over nothing. -->
        <template v-if="otherBoxes.length > 0">
            <p class="mt-1 px-2.5 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-subtle">Other sandboxes</p>
            <button
                v-for="box in otherBoxes"
                :key="box.sandbox.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': picked === box.sandbox.id }"
                :disabled="settled || !answering(box)"
                @click="place({ box: box.sandbox.id })"
            >
                <Icon name="boxes" class="mt-0.5 text-xs" :class="picked === box.sandbox.id ? 'text-primary-500' : 'text-subtle'" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">{{ box.sandbox.name }}</span>
                    <span class="text-2xs text-subtle">{{ boxDetail(box) }}</span>
                </span>
            </button>
            <!-- Said once, under the rows it is about, rather than on each of them: what a turn over there is
                 served by. It is the whole difference between this section and the two above it. -->
            <p v-if="!settled" class="px-2.5 py-1 text-2xs text-subtle">
                The turn runs there and streams back into this tab. It uses that sandbox's files and accounts, so this box's open file,
                @-mentions and personas stay behind.
            </p>
        </template>

        <p v-if="runners.length === 0 && otherBoxes.length === 0" class="px-2.5 py-1.5 text-2xs text-subtle">
            No runners yet. Add one on a connected computer under Sandbox ▸ Devices to run agents there.
        </p>
        <p v-else-if="settled" class="px-2.5 py-1.5 text-2xs text-subtle">
            This conversation already runs {{ placedAt }}. Start a new agent to work somewhere else.
        </p>
    </div>
</template>
