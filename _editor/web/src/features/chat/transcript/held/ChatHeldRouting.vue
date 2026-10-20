<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { loopLabel, loopOf, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentHarness, AgentProvider, QueuedMessage } from "@intentic/sandbox-contract/schemas/agent";
import { computed } from "vue";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { accountsOf } from "../../../../models/conversations/accounts/useChat-accounts";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { followPick } from "../../../../models/conversations/session/queueCalls";
import { type ServedApart, servedApart } from "../../../../models/conversations/session/waitingRouting";
import { modelLabelFor } from "../../../../models/providers/providerCatalog";

/* Where waiting words go when that is not where the composer points: said under their line, with the press that moves
   them. A pick moves them by itself (ComposerSelection, followPick), so this stands only where that did not happen: a
   pick in another window, a move the sandbox refused, words queued before it could move them. Before it, words booked
   on one model went out on it under a composer naming another, and nothing on screen said so (2026-10-20).
   On a chat with nothing above them yet (a booked first message), where they go is said either way: no answer, no
   divider and no earlier turn says which model they reach, and a switch there changed nothing on screen but the pill. */

const props = defineProps<{
    messages: readonly QueuedMessage[];
    compact?: boolean;
}>();

const t = useT();
const { conversation } = usePaneView();
const routing = computed(() => conversation.value.selection.followRouting.value);

// One side of the difference, named by the part that differs: the runtime with its model, the model, or the account.
interface Side {
    readonly agent: AgentProvider;
    readonly harness: AgentHarness;
    readonly model?: string | undefined;
    readonly account?: string | undefined;
}
const named = (side: Side, apart: ServedApart, other: Side): string => {
    const model = modelLabelFor(side.agent, side.model ?? ``);
    if (apart === `account`) {
        return accountsOf(side.agent).find((account) => account.id === side.account)?.label ?? side.account ?? model;
    }
    if (apart === `model`) {
        return model;
    }
    // The same provider through another loop is named by its loop; another provider by its own name too.
    return side.agent === other.agent ? `${model} · ${loopLabel(side.agent, loopOf(side.agent, side.harness))}` : `${providerLabel(side.agent)} · ${model}`;
};

// The first of these words served elsewhere, both sides named.
const elsewhere = computed(() => {
    for (const message of props.messages) {
        const apart = message.serves === undefined ? undefined : servedApart(message.serves, routing.value);
        if (message.serves !== undefined && apart !== undefined) {
            return { served: named(message.serves, apart, routing.value), pick: named(routing.value, apart, message.serves) };
        }
    }
    return undefined;
});

// Where they go, on a chat whose transcript has nothing in it yet: the runtime and the model, as the picker names them.
const goesOn = computed(() => {
    const serves = props.messages.find((message) => message.serves !== undefined)?.serves;
    const opened = conversation.value.transcript.messages.value.length > 0;
    return serves === undefined || opened ? undefined : named(serves, `runtime`, { ...serves, agent: `` });
});

const movable = computed(() => supportsRoute(`agent.queueReroute`));
const move = (): void => {
    void followPick(
        conversation.value,
        routing.value,
        props.messages.map((message) => message.id),
    );
};
</script>

<template>
    <p v-if="elsewhere" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle" :class="compact ? `` : `justify-end text-right`" role="note">
        <span>{{ t(`chat.chatHeld.servedElsewhere`, { served: elsewhere.served, pick: elsewhere.pick }) }}</span>
        <Button v-if="movable" size="small" thumb tier="quiet" @click="move()">{{ t(`chat.chatHeld.moveToPick`, messages.length) }}</Button>
    </p>
    <p v-else-if="goesOn" class="text-2xs text-subtle" :class="compact ? `` : `text-right`" role="note">
        {{ t(`chat.chatHeld.servedOn`, { served: goesOn }, messages.length) }}
    </p>
</template>
