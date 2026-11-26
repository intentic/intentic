<script setup lang="ts">
import { parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { isOpenNeed } from "@intentic/sandbox-contract/schemas/needs";
import { Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useAccess } from "../../../../client/sandbox/access/useAccess";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import { useNeeds } from "../../../../models/needs/useNeeds";
import { placeConversation } from "../pane/composerControls";
import { useFleetAdvice } from "./fleetAdvice";
import { autoPlacement, draftFleet, offeredMachine } from "./fleetPlacement";
import { hostTip, movedLine, offersReclaim, suggestLine } from "./fleetWords";
import { useFreeMemory } from "./freeMemory";

// One line above a new chat's composer while this machine is busy and one of the owner's runners has room (settings
// `offload.sessions`). `suggest` offers the machine and leaves the press to the person; `auto` has already placed the
// draft there and says so, with the press that keeps it here. Either way it is gone once the chat's first message is
// sent, since that is when its machine is decided for good. While the computer under this sandbox is what is short of
// memory the line names it in figures its owner can check (fleetWords.ts), and the owner can free some right here.

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

// "Free memory": the owner's alone (the route's floor), and only while the computer under this sandbox is what is short.
const access = useAccess();
const freeing = useFreeMemory();
const offerFree = computed(() => advice.value !== undefined && offersReclaim(advice.value) && access.can(`system.reclaimMemory`));
const freeingNow = computed(() => freeing.state.value.kind === `running`);
// What the last press came to, kept on the strip until waved away or pressed again.
const freedText = computed(() => (freeing.state.value.kind === `done` || freeing.state.value.kind === `failed` ? freeing.state.value.text : undefined));

// The hover with every figure behind the line, naming the card that proposes a smaller WSL VM while one waits for this
// computer (hosts/wsl-memory in the daemon) rather than saying it again.
const { needs } = useNeeds();
const wslCardWaits = computed(() => {
    const host = advice.value?.here.host?.name;
    return (
        host !== undefined &&
        needs.value.some((need) => isOpenNeed(need) && need.subject.kind === `wsl-memory` && parseHostConnection(need.subject.device).card === host)
    );
});
const tip = computed(() => (advice.value === undefined ? undefined : hostTip(advice.value.here, wslCardWaits.value)));

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
        <span v-tooltip="tip">{{ view.text }}</span>
        <span v-if="freedText !== undefined" class="mt-0.5 block text-2xs text-muted">{{ freedText }}</span>
        <template #actions>
            <Button v-if="offerFree" tier="boring" size="small" thumb :loading="freeingNow" :disabled="freeingNow" @click="freeing.press">
                {{ freeingNow ? t(`chat.fleetAdvice.freeingMemory`) : t(`chat.fleetAdvice.freeMemory`) }}
            </Button>
            <Button tier="accent" v-if="view.kind === `offer`" size="small" thumb @click="start(view.machine.runner)">
                {{ t(`chat.fleetAdvice.startThere`, { machine: view.machine.name }) }}
            </Button>
            <Button v-else size="small" thumb tier="quiet" @click="keepHere">{{ t(`chat.fleetAdvice.keepHere`) }}</Button>
        </template>
    </Notice>
    <!-- A press that took this machine back to calm takes the offer away with it: what it came to stays until waved away. -->
    <Notice v-else-if="freedText !== undefined" tone="info" icon="desktop" size="sm" :dismiss-label="t(`chat.fleetAdvice.dismiss`)" @dismiss="freeing.clear">
        {{ freedText }}
    </Notice>
</template>
