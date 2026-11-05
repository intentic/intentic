<script setup lang="ts">
import { Button, Icon, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { type WayOut, type WayOutKind, wayOutCut } from "../../../../models/conversations/endings/wayOut";
import { useAccessWall } from "../../../../models/conversations/endings/accessWall";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { turnFailureTelemetry } from "../../../../models/agent-status/turnFailureTelemetry";
import { useAgents } from "../../../../models/fleet/useAgents";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import ChatChooseModelButton from "../../models/ChatChooseModelButton.vue";

/* THE WAYS OUT OF A WALL THE SAME TURN KEEPS HITTING (wayOut.ts): drawn where Continue would be, on the same card, once
   the daemon has withdrawn Continue because pressing it again would only fail the same way. Every way is a press, and
   nothing here goes by itself. The bright one carries the conversation into a new one, which gets a copy of the
   workspace of its own; another model and one more try here stand beside it. The failure's own row above holds what
   happened in full, and its details hold (and copy) what the sandbox said, so this card says only how it repeats. */

const props = defineProps<{ wayOut: WayOut }>();

const t = useT();
const { conversation, messages, waiting, forkAt, continueTurn } = usePaneView();
const continuing = computed(() => conversation.value.turn.continuing.value);
const { reachable, activeSandboxId } = useSandbox();
const { agentById } = useAgents();
const card = computed(() => agentById(conversation.value.conversationId));
// No account of the provider can serve this conversation (accessWall.ts): the card over the composer then asks a person
// for that fix, which gets past the wall where these could not.
const accessWall = useAccessWall();
const shown = computed(() => accessWall.value === undefined);

const status = computed(() => {
    const { layer, repeats } = props.wayOut;
    if (layer === `workspace`) {
        return repeats >= 2 ? t(`chat.wayOut.workspaceRepeated`, { count: repeats }) : t(`chat.wayOut.workspace`);
    }
    return t(`chat.wayOut.repeated`, { count: repeats });
});

const offers = (way: WayOutKind): boolean => props.wayOut.ways.includes(way);
const tierOf = (way: WayOutKind): `accent` | `boring` | `quiet` => (way === props.wayOut.recommended ? `accent` : way === `retry` ? `quiet` : `boring`);
// Words the refusal handed back wait under their own press (ChatHeldMessages), which sends exactly them: this one would be
// a second press for the same attempt.
const retryOffered = computed(() => offers(`retry`) && waiting.value.length === 0);

const sandboxOf = (): string | undefined => card.value?.sandboxId ?? activeSandboxId.value;
watch(
    () => (shown.value && card.value !== undefined ? props.wayOut : undefined),
    (way) => {
        if (way !== undefined && card.value !== undefined) {
            turnFailureTelemetry.shown(card.value, sandboxOf(), way);
        }
    },
    { immediate: true },
);
const taken = (way: WayOutKind, id: string, since: number | undefined): void => {
    turnFailureTelemetry.taken(way, props.wayOut, { sandbox: sandboxOf(), id, since });
};

// A new conversation, carrying this one: cut above the person's last words when nothing answered them, so they reopen in
// its composer for a press of Send, else the whole of it. A conversation with a copy of its own takes its files as they
// were there; one in the shared tree has the workspace as it is. Words a refusal handed back to the queue go with it.
const newSessionHint = computed((): Tip => ({ title: t(`chat.wayOut.newTitle`), note: t(`chat.wayOut.newNote`) }));
const startNew = (): void => {
    const fork = forkAt(wayOutCut(messages.value), conversation.value.isolated.value ? `then` : `now`);
    if (fork === undefined) {
        return;
    }
    const held = waiting.value.filter((message) => message.voice === `person` && message.continues !== true).map((message) => message.text);
    if (fork.draft.value === `` && held.length > 0) {
        fork.draft.value = held.join(`\n\n`);
    }
    taken(`newConversation`, fork.conversationId, undefined);
};

const retryHint = computed((): Tip => ({ title: t(`chat.wayOut.tryTitle`), note: t(`chat.wayOut.tryNote`) }));
const retry = (): void => {
    if (continuing.value || !reachable.value) {
        return;
    }
    taken(`retry`, conversation.value.conversationId, card.value?.updatedAt);
    void continueTurn();
};
</script>

<template>
    <div v-if="shown" class="flex flex-col gap-1.5 rounded-xl bg-card shadow-sm px-3 py-2 text-2xs text-muted" data-way-out :data-layer="wayOut.layer">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon name="repeat" class="shrink-0" />
            <!-- Status text has a minimum width beside shrinkable controls, as the Continue card's does. -->
            <span class="min-w-[11rem] flex-1">{{ status }}</span>
            <div class="flex max-w-full shrink-0 flex-wrap items-center gap-1">
                <Button
                    v-if="retryOffered"
                    size="small"
                    thumb
                    :tier="tierOf(`retry`)"
                    :disabled="!reachable || continuing"
                    :loading="continuing"
                    v-tooltip.top="retryHint"
                    @click="retry"
                >
                    {{ t(`chat.wayOut.tryAgain`) }}
                </Button>
                <ChatChooseModelButton
                    v-if="offers(`otherModel`)"
                    :tier="tierOf(`otherModel`) === `accent` ? `accent` : `boring`"
                    :label="t(`chat.wayOut.otherModel`)"
                    @click="taken(`otherModel`, conversation.conversationId, card?.updatedAt)"
                />
                <Button
                    v-if="offers(`newConversation`)"
                    size="small"
                    thumb
                    :tier="tierOf(`newConversation`)"
                    v-tooltip.top="newSessionHint"
                    @click="startNew"
                >
                    <Icon name="fork" class="mr-1 text-2xs" />{{ t(`chat.wayOut.newConversation`) }}
                </Button>
            </div>
        </div>
    </div>
</template>
