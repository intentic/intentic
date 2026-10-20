<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { boxNameOf } from "../../../models/fleet/fleetScope";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { placeConversation } from "./pane/composerControls";
import { type BoxFleet, otherBoxes, subscribe as watchOtherBoxes } from "../../../models/sandbox/live/fleetAcross";
import { useRunners } from "../../../models/sandbox/devices/useRunners";
import { SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useFleetAdvice } from "./fleet/fleetAdvice";
import { draftFleet } from "./fleet/fleetPlacement";
import { loadLine, unfitWords } from "./fleet/fleetWords";

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

const t = useT();

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

const { runners } = useRunners();
// How full each machine is right now, and the one a new chat should start on while this one is busy (fleetAdvice.ts):
// read while the menu is open on a draft, the same query the composer's strip reads.
const { advice } = useFleetAdvice(() => conversation);
const machineOf = (id: string) => advice.value?.machines.find((machine) => machine.runner === id);
const suggested = computed(() => advice.value?.suggestion?.runner);
const hereLine = computed(() => (advice.value === undefined ? t(`chat.chatPlacementMenu.runsOnMachineWorkspace`) : loadLine(advice.value.here)));

// Other boxes are read only while this menu is open, the switcher popover's own rule: this store polls every
// sandbox the account owns, so mounting only while watched is exactly what it's for.
onUnmounted(watchOtherBoxes());

const picked = computed(() => conversation.box.value);
const pickedRunner = computed(() => conversation.runner.value);
// The board seeing this conversation settles its placement (Conversation.registered); a draft is the window.
const settled = computed(() => conversation.registered.value);

// The row's line under the name: an outdated runner is still offered and says so — it still runs turns, and
// updating first vs. running now is the user's call (Devices has the button).
// With the fleet advice in hand the line is the machine's standing, or why this chat could not start there; without it
// (a settled conversation, a daemon that predates it) the hello's own figures.
const detail = (runner: { id: string; online: boolean; parity: string; facts?: { cpus: number; load: number } }): string => {
    if (!runner.online) {
        return t(`chat.chatPlacementMenu.runnerOffline`);
    }
    const machine = machineOf(runner.id);
    const load =
        machine?.unfit !== undefined
            ? unfitWords(machine.unfit)
            : machine?.load !== undefined
              ? loadLine(machine.load)
              : runner.facts === undefined
                ? t(`chat.chatPlacementMenu.runnerReady`)
                : t(`chat.chatPlacementMenu.runnerLoad`, { cpus: runner.facts.cpus, load: runner.facts.load.toFixed(2) });
    return runner.parity === `outdated` ? `${load} · ${t(`chat.chatPlacementMenu.runnerOutdated`)}` : load;
};

// A box that's never answered isn't offered: a turn posted to an absent daemon fails at the door.
const answering = (box: BoxFleet): boolean => box.state === `ready`;

const boxDetail = (box: BoxFleet): string =>
    box.state === `ready`
        ? t(`chat.chatPlacementMenu.boxReady`)
        : box.state === `reading`
          ? t(`chat.chatPlacementMenu.boxReading`)
          : t(`chat.chatPlacementMenu.boxAsleep`);

// Named from the roster, not from anything stored on the conversation, so a later rename stays true.
const placedAt = computed(() => {
    if (picked.value !== undefined) {
        return t(`chat.chatPlacementMenu.placedInBox`, { name: boxNameOf.value.get(picked.value) ?? t(`chat.chatPlacementMenu.anotherSandbox`) });
    }
    return pickedRunner.value === undefined
        ? t(`chat.chatPlacementMenu.placedHere`)
        : t(`chat.chatPlacementMenu.placedOnRunner`, { name: pickedRunner.value });
});

// A pick here is the person's, which no automatic placement moves again (fleetAdvice.ts autoPlacement).
const place = (at: { box?: string; runner?: string }): void => {
    if (placeConversation(conversation, at)) {
        draftFleet(conversation).by = `person`;
        emit(`selected`);
    }
};
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3 text-sm md:text-xs"
            :class="{ 'ui-row-select-on': picked === undefined && pickedRunner === undefined }"
            :disabled="settled"
            @click="place({})"
        >
            <Icon
                name="box"
                class="text-xs"
                :class="picked === undefined && pickedRunner === undefined ? 'text-accent' : 'text-subtle'"
            />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ t(`shared.thisSandbox`) }}</span>
                <span class="text-2xs text-subtle">{{ hereLine }}</span>
            </span>
        </button>
        <button
            v-for="runner in runners"
            :key="runner.id"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3 text-sm md:text-xs"
            :class="{ 'ui-row-select-on': pickedRunner === runner.id }"
            :disabled="settled || !runner.online"
            @click="place({ runner: runner.id })"
        >
            <Icon name="desktop" class="text-xs" :class="pickedRunner === runner.id ? 'text-accent' : 'text-subtle'" />
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-center gap-1.5">
                    <span class="text-sm text-content md:text-xs">{{ runner.id }}</span>
                    <!-- The machine the fleet would start this chat on, said where the person is already choosing. -->
                    <span v-if="suggested === runner.id && !settled" class="rounded-full bg-primary-500/15 px-1.5 text-2xs font-medium text-link">{{
                        t(`chat.fleetAdvice.suggested`)
                    }}</span>
                </span>
                <span class="text-2xs text-subtle">{{ detail(runner) }}</span>
            </span>
        </button>

        <!-- Other workspaces on this account, under their own heading (a bigger step than the rows above); absent on a single-sandbox account. -->
        <template v-if="otherBoxes.length > 0">
            <SectionHeader :label="t(`chat.chatPlacementMenu.otherSandboxes`)" density="dense" class="mt-1 px-2.5 pb-0.5 pt-1.5" />
            <button
                v-for="box in otherBoxes"
                :key="box.sandbox.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3 text-sm md:text-xs"
                :class="{ 'ui-row-select-on': picked === box.sandbox.id }"
                :disabled="settled || !answering(box)"
                @click="place({ box: box.sandbox.id })"
            >
                <Icon name="boxes" class="text-xs" :class="picked === box.sandbox.id ? 'text-accent' : 'text-subtle'" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">{{ box.sandbox.name }}</span>
                    <span class="text-2xs text-subtle">{{ boxDetail(box) }}</span>
                </span>
            </button>
            <!-- Said once under the section, not per row: the whole difference from this sandbox and its runners is what a remote turn is served by. -->
            <p v-if="!settled" class="px-2.5 py-1 text-2xs text-subtle">
                {{ t(`chat.chatPlacementMenu.turnRunsStreamsBack`) }}
            </p>
        </template>

        <p v-if="runners.length === 0 && otherBoxes.length === 0" class="px-2.5 py-1.5 text-2xs text-subtle">
            {{ t(`chat.chatPlacementMenu.noRunnersYetAdd`) }}
        </p>
        <p v-else-if="settled" class="px-2.5 py-1.5 text-2xs text-subtle">
            {{ t(`chat.chatPlacementMenu.conversationAlreadyRunsStart`, { placedAt }) }}
        </p>
    </div>
</template>
