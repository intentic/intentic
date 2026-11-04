<!-- A PRIVATE CONVERSATION THE READER CANNOT READ, drawn in place of its chat (ChatPanel): whose it is, and the ways in.
     The one step the page asks for is asking its author (accent), which then stands as a fact while they wait. The
     sandbox owner alone also has a quiet door, opening it without asking, which unfolds its form here (SealOpenForm).
     An opening that waits on a second person shows its opener that it waits, and whoever could be that second person what
     they are asked to agree to. Its work stays the team's: what it has to land is offered as it is in any chat. -->
<script setup lang="ts">
import { Avatar, Button } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAuth } from "../../../../client/auth/useAuth";
import { useRole } from "../../../../client/sandbox/useRole";
import { identityHue } from "../../../../lib/identityHue";
import { askToRead, answerOpening } from "../../../../models/fleet/presses/sealPresses";
import { firstName, fullName, isOpener, sealAuthor } from "../../../../models/agent-status/sealView";
import { useAgents } from "../../../../models/fleet/useAgents";
import ChatLandStrip from "../landing/ChatLandStrip.vue";
import { landStripOf } from "../landing/landStrip";
import SealOpenForm from "./SealOpenForm.vue";

const t = useT();

const { conversationId } = defineProps<{ conversationId: string }>();

const { user } = useAuth();
const { canShip, canReview } = useRole();

const { agentById } = useAgents();
const agent = computed(() => agentById(conversationId));
const seal = computed(() => agent.value?.seal);
const author = computed(() => sealAuthor(seal.value));
const name = computed(() => firstName(author.value));
const pending = computed(() => seal.value?.pending);
const mine = computed(() => isOpener(pending.value, user.value?.email ?? undefined));
const approving = computed(() => pending.value !== undefined && !mine.value && seal.value?.canApprove === true);

const busy = ref(false);
const failure = ref<string>();
const run = async (task: () => Promise<void>, fallback: string): Promise<void> => {
    busy.value = true;
    failure.value = undefined;
    try {
        await task();
    } catch (error) {
        failure.value = messageOr(error, fallback);
    } finally {
        busy.value = false;
    }
};
const ask = (): Promise<void> => run(() => askToRead(conversationId), t(`chat.seal.gate.askFailed`));
const answer = (agree: boolean): Promise<void> => {
    const open = pending.value;
    return open === undefined ? Promise.resolve() : run(() => answerOpening(conversationId, open.id, agree), t(`chat.seal.openings.answerFailed`));
};

const opening = ref(false);

// Its work, which is shared: ready to land, landing, or refused, with the press any chat offers for it.
const landStrip = computed(() =>
    landStripOf(agent.value, { canAct: canShip.value || canReview.value, streaming: false, elsewhere: agent.value?.sandboxId !== undefined }),
);
</script>

<template>
    <div class="chat-pane @container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-seal-gate>
        <div class="mx-auto flex w-full max-w-md flex-col items-start gap-4 px-6 py-12">
            <Avatar :size="40" :name="fullName(author)" :hue="identityHue(author?.email ?? conversationId)" />
            <div class="flex flex-col gap-1.5">
                <h2 class="text-lg font-semibold text-content">{{ t(`chat.seal.gate.heading`, { name }) }}</h2>
                <p class="text-sm leading-relaxed text-muted">{{ t(`chat.seal.gate.explain`) }}</p>
            </div>

            <!-- The opener's own opening, waiting on the second person the organisation asks for. -->
            <div v-if="pending !== undefined && mine" class="flex flex-col gap-1.5 text-sm" data-seal-waiting>
                <p class="flex items-center gap-2 font-medium text-content"><Icon name="clock" class="shrink-0 text-xs text-subtle" />{{ t(`chat.seal.gate.waitingSecond`) }}</p>
                <q class="text-muted">{{ pending.reason }}</q>
            </div>
            <!-- What the second person is asked to agree to: who, and why in their words. -->
            <div v-else-if="approving && pending !== undefined" class="flex w-full flex-col gap-3 text-sm" data-seal-approve>
                <p class="font-medium text-content">{{ t(`chat.seal.gate.approveAsk`, { name: fullName(pending), author: name }) }}</p>
                <q class="text-muted">{{ pending.reason }}</q>
                <div class="flex flex-wrap items-center gap-2">
                    <Button tier="accent" :loading="busy" :disabled="busy" @click="answer(true)">{{ t(`chat.seal.openings.approve`) }}</Button>
                    <Button tier="boring" :disabled="busy" @click="answer(false)">{{ t(`chat.seal.openings.refuse`) }}</Button>
                </div>
            </div>
            <template v-else>
                <span v-if="seal?.asked === true" class="inline-flex items-center gap-2 text-sm text-muted" data-seal-asked>
                    <Icon name="clock" class="shrink-0 text-xs" />{{ t(`chat.seal.gate.asked`, { name }) }}
                </span>
                <!-- The one step this page asks for, until the owner unfolds the other door: then that form's confirm is the step. -->
                <Button v-else :tier="opening ? `boring` : `accent`" :loading="busy" :disabled="busy" @click="ask">{{ t(`chat.seal.gate.ask`, { name }) }}</Button>
                <!-- The owner's quiet door, which only unfolds: nothing is sent until the passkey confirms it. -->
                <Button v-if="seal?.canOpen === true && !opening" tier="quiet" @click="opening = true">{{ t(`chat.seal.gate.openWithout`) }}</Button>
                <SealOpenForm v-if="seal?.canOpen === true && opening" :conversation-id="conversationId" :author="name" @cancel="opening = false" />
            </template>
            <p v-if="failure !== undefined" role="alert" class="text-xs text-danger">{{ failure }}</p>

            <ChatLandStrip v-if="agent !== undefined && landStrip !== undefined" :agent="agent" :strip="landStrip" class="w-full" />
        </div>
    </div>
</template>
