<!-- A redirect need's own answer: a person's message that reached the wrong sandbox, offered on to the one it was meant
     for (docs/architecture/account-routing.md). The words are the daemon's copy of what they typed, shown whole, and only
     they can send them: the press records the answer, then opens a chat in the target from this editor, signed in to
     both, and sends the words there as typing them would. No pass and no pairing are involved. "Keep it here" declines,
     which wakes the agent to carry on with the message. Anyone else reads whom it waits on. -->
<script setup lang="ts">
import type { Need, RedirectNeed } from "@intentic/sandbox-contract/schemas/needs";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../../components/ChatDecisionButton.vue";
import { useAuth } from "../../../client/auth/useAuth";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { startAgent } from "../../../models/fleet/agentActions";
import { useNeeds } from "../../../models/needs/useNeeds";
import { useNeedAnswer } from "../needAnswer";
import { farSandboxOf } from "./routeTarget";

const t = useT();

const props = defineProps<{ need: Need; subject: RedirectNeed }>();

const needs = useNeeds();
const { user } = useAuth();
const { sandboxes } = useSandbox();
// Their own words: the daemon's answer checks the same address.
const theirs = computed(() => user.value?.email.toLowerCase() === props.subject.person.toLowerCase());
const far = computed(() => farSandboxOf(sandboxes.value, props.subject));
const target = computed(() => props.subject.targetName);

const { busy, notice, answer } = useNeedAnswer(() => props.need);
// The answer first, so a press the daemon refuses sends nothing and a second press cannot send the words twice.
const send = async (): Promise<void> => {
    const box = far.value?.id;
    if (box === undefined) {
        return;
    }
    const id = props.need.id;
    const words = props.subject.words;
    await answer({
        failed: t(`needs.card.couldNotAnswer`),
        task: async () => {
            await needs.answer.mutateAsync({ id, answer: { kind: `approve` } });
            startAgent(words, undefined, undefined, { box });
        },
    });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">
            {{ subject.project ? t(`needs.redirect.leadProject`, { target, project: subject.project }) : t(`needs.redirect.lead`, { target }) }}
        </p>
        <blockquote class="max-h-48 overflow-auto whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-xs text-content" data-redirect-words>{{ subject.words }}</blockquote>
        <span v-if="subject.clipped" class="text-2xs text-subtle" data-redirect-clipped>{{ t(`needs.redirect.clipped`) }}</span>
        <span v-if="subject.attachments" class="text-2xs text-subtle" data-redirect-files>{{
            t(`needs.redirect.attachments`, { count: subject.attachments }, subject.attachments)
        }}</span>
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <template v-if="theirs">
                <ChatDecisionButton v-if="far" tone="primary" icon="send" :disabled="busy" @click="send">{{ t(`needs.redirect.approve`, { target }) }}</ChatDecisionButton>
                <span v-else class="text-2xs text-subtle" data-redirect-unreachable>{{ t(`needs.redirect.unreachable`, { target }) }}</span>
            </template>
            <span v-else class="text-2xs text-subtle" data-redirect-waits>{{ t(`needs.redirect.personOnly`, { person: subject.person }) }}</span>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
