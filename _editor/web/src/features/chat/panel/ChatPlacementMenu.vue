<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { boxNameOf } from "../../agents/fleet/fleetScope";
import type { Conversation } from "../session/conversation";
import { type BoxFleet, otherBoxes, subscribe as watchOtherBoxes } from "../../sandbox/live/fleetAcross";
import { useRunners } from "../../sandbox/devices/useRunners";

// Where this conversation runs — three answers to one question:
//
// - This sandbox: the workspace on screen, on its own machine
// - A runner: a container on another of your computers, running this sandbox's workspace (only CPU/memory moves)
// - Another sandbox: a different workspace and machine entirely (the work's address moves)
//
// A remote conversation doesn't carry this box's open file, mentions, personas or account pick (turnRequest.ts
// spells out each omission); provider and model still cross. Offered only before the first turn, since placement
// latches with the branch then (Conversation.registered) and that box is the only one that can continue it.
// Offline runners and unreachable sandboxes are listed but not selectable.

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

const { runners } = useRunners();

// Other boxes are read only while this menu is open, the switcher popover's own rule: this store polls every
// sandbox the account owns, so mounting only while watched is exactly what it's for.
onUnmounted(watchOtherBoxes());

const picked = computed(() => conversation.box.value);
const pickedRunner = computed(() => conversation.runner.value);
// The board seeing this conversation settles its placement (Conversation.registered); a draft is the window.
const settled = computed(() => conversation.registered.value);

// The row's line under the name: an outdated runner is still offered and says so — it still runs turns, and
// updating first vs. running now is the user's call (Devices has the button).
const detail = (runner: { online: boolean; parity: string; facts?: { cpus: number; load: number } }): string => {
    if (!runner.online) {
        return `Offline — wake that machine to use it`;
    }
    const load = runner.facts === undefined ? `Ready` : `${runner.facts.cpus} cores · load ${runner.facts.load.toFixed(2)}`;
    return runner.parity === `outdated` ? `${load} · older build than this sandbox` : load;
};

// A box that's never answered isn't offered: a turn posted to an absent daemon fails at the door.
const answering = (box: BoxFleet): boolean => box.state === `ready`;

const boxDetail = (box: BoxFleet): string =>
    box.state === `ready`
        ? `Its workspace, its accounts, its agents`
        : box.state === `reading`
          ? `Checking whether it's awake…`
          : `Not answering — it may be asleep`;

// Named from the roster, not from anything stored on the conversation, so a later rename stays true.
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
    // The two axes are one choice, so each pick clears the other: a runner belongs to the sandbox that paired it, and
    // "that runner in another box" names nothing there.
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

        <!--
            Other workspaces on this account, under their own heading (a bigger step than the rows above); absent on a
            single-sandbox account.
        -->
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
            <!--
                Said once under the section, not per row: the whole difference from this sandbox and its runners is what a
                remote turn is served by.
            -->
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
