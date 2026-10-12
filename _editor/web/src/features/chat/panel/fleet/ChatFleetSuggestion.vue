<script setup lang="ts">
import { Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import type { Conversation } from "../../session/conversation";
import { placeConversation } from "../pane/composerControls";
import { useFleetAdvice } from "./fleetAdvice";
import { autoPlacement, draftFleet, offeredMachine } from "./fleetPlacement";
import { movedLine, suggestLine } from "./fleetWords";

// One line above a new chat's composer while this machine is busy and one of the owner's runners has room (settings
// `offload.sessions`). `suggest` offers the machine and leaves the press to the person; `auto` has already placed the
// draft there and says so, with the press that keeps it here. Either way it is gone once the chat's first message is
// sent, since that is when its machine is decided for good.

const t = useT();

const { conversation } = defineProps<{ conversation: Conversation }>();
// The draft moved to another machine from here, for the pane to light the placement pill that now names it.
const emit = defineEmits<{ placed: [] }>();

const { advice } = useFleetAdvice(() => conversation);
const draft = computed(() => draftFleet(conversation));
const runner = computed(() => conversation.runner.value);

// `auto`: follows the advice for a draft nobody placed by hand (fleetAdvice.ts autoPlacement says when).
watch(
    [advice, runner],
    () => {
        const next = autoPlacement(advice.value, { ...draft.value, runner: runner.value });
        if (next === undefined || !placeConversation(conversation, { runner: next.runner })) {
            return;
        }
        draft.value.by = next.runner === undefined ? undefined : `fleet`;
        emit(`placed`);
    },
    { immediate: true },
);

const offered = computed(() => offeredMachine(advice.value, draft.value.offered));
watch(offered, (machine) => {
    if (machine !== undefined) {
        draft.value.offered = machine.runner;
    }
});

const nameOf = (id: string): string => advice.value?.machines.find((machine) => machine.runner === id)?.name ?? id;

// What the line says: that the fleet moved the draft, or which machine it could go to. Nothing once the person placed
// it themselves or waved the offer away.
const view = computed(() => {
    const now = advice.value;
    if (now === undefined) {
        return undefined;
    }
    if (draft.value.by === `fleet` && runner.value !== undefined) {
        return { kind: `moved` as const, text: movedLine(now.here, nameOf(runner.value)) };
    }
    if (now.mode !== `suggest` || draft.value.by === `person` || draft.value.dismissed || runner.value !== undefined || offered.value === undefined) {
        return undefined;
    }
    return { kind: `offer` as const, machine: offered.value, text: suggestLine(now.here, offered.value.name) };
});

const start = (to: string): void => {
    if (placeConversation(conversation, { runner: to })) {
        draft.value.by = `person`;
        emit(`placed`);
    }
};

// Here for good on this draft: neither the offer nor an automatic move comes back for it.
const keepHere = (): void => {
    draft.value.dismissed = true;
    if (draft.value.by === `fleet` && placeConversation(conversation, {})) {
        draft.value.by = `person`;
        emit(`placed`);
    }
};
</script>

<template>
    <Notice
        v-if="view !== undefined"
        tone="info"
        icon="desktop"
        size="sm"
        :dismiss-label="view.kind === `offer` ? t(`chat.fleetAdvice.notNow`) : ``"
        @dismiss="keepHere"
    >
        {{ view.text }}
        <template #actions>
            <Button v-if="view.kind === `offer`" size="small" thumb @click="start(view.machine.runner)">
                {{ t(`chat.fleetAdvice.startThere`, { machine: view.machine.name }) }}
            </Button>
            <Button v-else size="small" thumb tier="quiet" @click="keepHere">{{ t(`chat.fleetAdvice.keepHere`) }}</Button>
        </template>
    </Notice>
</template>
