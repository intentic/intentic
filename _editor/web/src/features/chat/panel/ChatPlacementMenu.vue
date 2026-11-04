<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { boxNameOf } from "../../../models/fleet/fleetScope";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { placeConversation } from "./pane/composerControls";
import { type BoxFleet, otherBoxes, subscribe as watchOtherBoxes } from "../../../models/sandbox/live/fleetAcross";
import { useRunners } from "../../../models/sandbox/devices/useRunners";
import { Button, SectionHeader } from "@intentic/ui";
import { startAgent } from "../../../models/fleet/agentActions";
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
//
// Once it has latched the menu stops being a list of choices: rows that cannot be picked drew people into pressing each
// in turn before finding the one line that said why. It reads instead as where the chat runs, locked, the reason, and
// the one way forward (a new agent, whose own menu is open again).

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

// Where a settled conversation runs, drawn as the one row it can be: named from the roster, not from anything stored on
// the conversation, so a later rename stays true.
const placedRow = computed(() => {
    if (picked.value !== undefined) {
        const box = otherBoxes.value.find((candidate) => candidate.sandbox.id === picked.value);
        return {
            icon: `boxes` as const,
            name: boxNameOf.value.get(picked.value) ?? t(`chat.chatPlacementMenu.anotherSandbox`),
            line: box === undefined ? undefined : boxDetail(box),
        };
    }
    if (pickedRunner.value !== undefined) {
        const runner = runners.value.find((candidate) => candidate.id === pickedRunner.value);
        return { icon: `desktop` as const, name: pickedRunner.value, line: runner === undefined ? undefined : detail(runner) };
    }
    return { icon: `box` as const, name: t(`shared.thisSandbox`), line: hereLine.value };
});

// The way to work somewhere else: a fresh draft, whose own menu offers every place again.
const startElsewhere = (): void => {
    startAgent();
    emit(`selected`);
};

// A pick here is the person's, which no automatic placement moves again (fleetAdvice.ts autoPlacement).
const place = (at: { box?: string; runner?: string }): void => {
    if (placeConversation(conversation, at)) {
        draftFleet(conversation).by = `person`;
        emit(`selected`);
    }
};
</script>

<template>
    <div v-if="settled" class="flex flex-col p-1">
        <div class="ui-row-select-on flex items-start gap-2 rounded-lg px-2.5 py-1.5 max-md:py-3">
            <Icon :name="placedRow.icon" class="text-xs text-accent" />
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm text-content md:text-xs">{{ placedRow.name }}</span>
                <span v-if="placedRow.line !== undefined" class="text-2xs text-subtle">{{ placedRow.line }}</span>
            </span>
            <Icon name="lock" class="shrink-0 text-2xs text-subtle" :aria-label="t(`chat.chatPlacementMenu.fixedAria`)" />
        </div>
        <p class="px-2.5 pb-2 pt-2 text-2xs text-subtle">{{ t(`chat.chatPlacementMenu.fixedNote`) }}</p>
        <Button size="small" tier="accent" :label="t(`chat.words.newAgent`)" class="mx-2.5 mb-1.5 self-start" @click="startElsewhere">
            <template #icon><Icon name="plus" /></template>
        </Button>
    </div>
    <div v-else class="flex flex-col p-1">
        <button
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3 text-sm md:text-xs"
            :class="{ 'ui-row-select-on': picked === undefined && pickedRunner === undefined }"
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
            :disabled="!runner.online"
            @click="place({ runner: runner.id })"
        >
            <Icon name="desktop" class="text-xs" :class="pickedRunner === runner.id ? 'text-accent' : 'text-subtle'" />
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-center gap-1.5">
                    <span class="text-sm text-content md:text-xs">{{ runner.id }}</span>
                    <!-- The machine the fleet would start this chat on, said where the person is already choosing. -->
                    <span v-if="suggested === runner.id" class="rounded-full bg-primary-500/15 px-1.5 text-2xs font-medium text-link">{{
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
                :disabled="!answering(box)"
                @click="place({ box: box.sandbox.id })"
            >
                <Icon name="boxes" class="text-xs" :class="picked === box.sandbox.id ? 'text-accent' : 'text-subtle'" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">{{ box.sandbox.name }}</span>
                    <span class="text-2xs text-subtle">{{ boxDetail(box) }}</span>
                </span>
            </button>
            <!-- Said once under the section, not per row: the whole difference from this sandbox and its runners is what a remote turn is served by. -->
            <p class="px-2.5 py-1 text-2xs text-subtle">
                {{ t(`chat.chatPlacementMenu.turnRunsStreamsBack`) }}
            </p>
        </template>

        <p v-if="runners.length === 0 && otherBoxes.length === 0" class="px-2.5 py-1.5 text-2xs text-subtle">
            {{ t(`chat.chatPlacementMenu.noRunnersYetAdd`) }}
        </p>
    </div>
</template>
